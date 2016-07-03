// ==UserScript==
// @name         Gentoo Bugzilla bug assignment helper
// @namespace    http://dev.gentoo.org/~mgorny/bug-assign
// @version      0
// @description  Helper to suggest proper assignees for a bug
// @author       Michał Górny
// @match        https://bugs.gentoo.org/*
// ==/UserScript==

(function()
{
    'use strict';

    // current package list
    var packageList = [];
    // object where keys are packages and values are maintainer lists from json
    var maintainers = {};
    // object where keys are maintainer emails and values are objects with maint boxes
    var maintElems = {};
    // object where keys are packages and values are maintainer groups
    var maintGroups = {};
    // number of requests in progress
    var reqInProgress = 0;

    // create the outer box used to contain bug assignment data
    function createBox()
    {
        var top = document.querySelector('#bz_show_bug_column_2 tbody');
        if (top !== null)
        {
            // bug edit form
            var tr = document.createElement('tr');
            tr.innerHTML += ('<th class="field_label">Maintainers:</th><td>' +
                             '<form action="#"><table id="bug-assign-table">' +
                             '</table></form></td>');
            top.appendChild(tr);
        }
        else
        {
            // bug file form
            var over = document.querySelector('#field_container_bug_status + td + td');
            var newRowSpan = over.rowSpan - 1;
            over.rowSpan = 1;

            var left = document.querySelector('#field_label_assigned_to + td');
            left.colSpan = 1;

            var th = document.createElement('th');
            th.class = 'field_label';
            th.textContent = 'Maintainers:';
            left.parentNode.appendChild(th);

            var td = document.createElement('td');
            td.rowSpan = newRowSpan;
            td.innerHTML = ('<form action="#"><table id="bug-assign-table">' +
                            '</table></form>');
            left.parentNode.appendChild(td);
        }
    }

    // add triggers for auto-updates where appropriate
    function addTriggers()
    {
        // summary edits
        var summaryInput = document.getElementById('short_desc');
        summaryInput.addEventListener('keyup', function(ev) {
            if ('bugARefreshTimeout' in ev.target)
                window.clearTimeout(ev.target.bugARefreshTimeout);
            ev.target.bugARefreshTimeout = window.setTimeout(updatePackages, 2000);
        });
        summaryInput.addEventListener('change', function(ev) {
            if ('bugARefreshTimeout' in ev.target)
                window.clearTimeout(ev.target.bugARefreshTimeout);
            updatePackages();
        });

        // assignee edits
        var assignInput = document.getElementById('assigned_to');
        assignInput.addEventListener('keyup', function(ev) {
            if ('bugARefreshTimeout' in ev.target)
                window.clearTimeout(ev.target.bugARefreshTimeout);
            ev.target.bugARefreshTimeout = window.setTimeout(syncMaintainerStatesToBug, 2000);
        });
        assignInput.addEventListener('change', function(ev) {
            if ('bugARefreshTimeout' in ev.target)
                window.clearTimeout(ev.target.bugARefreshTimeout);
            syncMaintainerStatesToBug();
        });

        // assignee reset
        var assignReset = document.getElementById('set_default_assignee');
        if (assignReset !== null)
            assignReset.addEventListener('change', syncMaintainerStatesToBug);

        // 'add cc' edits
        var newCCInput = document.getElementById('newcc');
        if (newCCInput === null)
            newCCInput = document.getElementById('cc');
        newCCInput.addEventListener('keyup', function(ev) {
            if ('bugARefreshTimeout' in ev.target)
                window.clearTimeout(ev.target.bugARefreshTimeout);
            ev.target.bugARefreshTimeout = window.setTimeout(syncMaintainerStatesToBug, 2000);
        });
        newCCInput.addEventListener('change', function(ev) {
            if ('bugARefreshTimeout' in ev.target)
                window.clearTimeout(ev.target.bugARefreshTimeout);
            syncMaintainerStatesToBug();
        });

        // cc removal list
        var removeCCBox = document.getElementById('removecc');
        if (removeCCBox !== null)
        {
            removeCCBox.addEventListener('change', syncMaintainerStatesToBug);
            var removeCCSelect = document.getElementById('cc');
            removeCCSelect.addEventListener('change', syncMaintainerStatesToBug);
        }
    }

    // perform brace expansion
    function performBraceExpansion(s)
    {
        var words = s.split(/[\s]/);
        var braceExpansion = true;

        while (braceExpansion)
        {
            var expanded = [];
            braceExpansion = false;

            for (var i = 0; i < words.length; ++i)
            {
                var m = words[i].match(/^(.*){([^}]*,[^}]*)}(.*)$/);
                if (m)
                {
                    var spl = m[2].split(',');
                    for (var j = 0; j < spl.length; ++j)
                        expanded.push(m[1] + spl[j] + m[3]);
                    braceExpansion = true;
                }
                else
                    expanded.push(words[i]);
            }

            words = expanded;
        }

        return words.join(' ');
    }

    // find package names in summary and return them as array
    // TODO: support brace expansion
    function getPackageNames()
    {
        var summ = performBraceExpansion(document.getElementById('short_desc').value);
        var words = summ.split(/[\s,;]/);
        var pnames = [];
        for (var i = 0; i < words.length; ++i)
        {
            // strip leading and trailing symbols
            var cpv = words[i].replace(/^\W*/, '').replace(/\W*$/, '');

            // category/package(-version)?
            if (cpv.match(/^\w[\w+.-]*\/\w[\w+-]*(-\d+(\.\d+)*[a-z]?((_alpha|_beta|_pre|_rc|_p)\d*)?(-r\d+)?)?$/))
            {
                // strip the version if any
                var cp = cpv.replace(/-\d+(\.\d+)*[a-z]?((_alpha|_beta|_pre|_rc|_p)\d*)?(-r\d+)?$/, '');
                pnames.push(cp);
            }
        }

        return pnames;
    }

    // fill in the maintainer table using data from 'maintainers' object
    function updateMaintainerTable()
    {
        var topbox = document.getElementById('bug-assign-table');
        topbox.innerHTML = '';

        if (Object.keys(maintainers).length === 0)
        {
            topbox.innerHTML = 'No valid packages found';
            return;
        }

        var tr, td, input;

        // header row
        tr = document.createElement('tr');
        topbox.appendChild(tr);
        td = document.createElement('th');
        tr.appendChild(td);
        td = document.createElement('th');
        td.textContent = 'A';
        tr.appendChild(td);
        td = document.createElement('th');
        td.textContent = 'CC';
        tr.appendChild(td);

        // reset
        maintElems = {};

        // use the original package list to preserve order
        for (var i = 0; i < packageList.length; ++i)
        {
            var pkg = packageList[i];
            if (!(pkg in maintainers))
                continue;

            tr = document.createElement('tr');
            topbox.appendChild(tr);

            td = document.createElement('th');
            td.textContent = pkg;
            tr.appendChild(td);

            td = document.createElement('td');
            var groupA = document.createElement('input');
            groupA.type = 'checkbox';
            groupA.maintainers = [];
            groupA.pkg = pkg;
            groupA.addEventListener('change', groupAssignExplicitChange);
            td.appendChild(groupA);
            tr.appendChild(td);

            td = document.createElement('td');
            var groupCC = document.createElement('input');
            groupCC.type = 'checkbox';
            groupCC.maintainers = [];
            groupCC.pkg = pkg;
            groupCC.addEventListener('change', groupCCExplicitChange);
            td.appendChild(groupCC);
            tr.appendChild(td);

            maintGroups[pkg] = {
                'a': groupA,
                'cc': groupCC
            };

            // check for maintainer-needed packages
            if (maintainers[pkg].length === 0)
            {
                maintainers[pkg] = [
                    {
                        'email': 'maintainer-needed@gentoo.org'
                    }
                ];
            }

            for (var m in maintainers[pkg])
            {
                var mdata = maintainers[pkg][m];
                tr = document.createElement('tr');
                topbox.appendChild(tr);

                if (!(mdata.email in maintElems))
                {
                    maintElems[mdata.email] = {
                        'a': [],
                        'cc': []
                    };
                }

                var full_name = '';
                if (mdata.name !== null)
                    full_name = mdata.name + ' ';
                full_name += '<' + mdata.email + '>';

                td = document.createElement('td');
                var maintText = document.createElement('span');
                maintText.textContent = mdata.email;
                maintText.title = full_name;
                td.appendChild(maintText);
                tr.appendChild(td);

                td = document.createElement('td');
                input = document.createElement('input');
                input.type = 'checkbox';
                input.email = mdata.email;
                input.groupA = groupA;
                input.groupCC = groupCC;
                maintElems[mdata.email].a.push(input);
                input.addEventListener('change', maintainerAssignExplicitChange);
                td.appendChild(input);
                tr.appendChild(td);

                td = document.createElement('td');
                input = document.createElement('input');
                input.type = 'checkbox';
                input.email = mdata.email;
                input.groupA = groupA;
                input.groupCC = groupCC;
                maintElems[mdata.email].cc.push(input);
                input.addEventListener('change', maintainerCCExplicitChange);
                td.appendChild(input);
                tr.appendChild(td);

                groupA.maintainers.push(mdata.email);
                groupCC.maintainers.push(mdata.email);

                if (mdata.description !== null)
                {
                    tr = document.createElement('tr');
                    topbox.appendChild(tr);
                    td = document.createElement('td');
                    td.style = 'font-size: 40%;';
                    td.textContent = mdata.description;
                    tr.appendChild(td);
                }
            }
        }

        syncMaintainerStatesToBug();
    }

    // Set all maintainer checkboxes to a specific state
    // @email: maintainer's e-mail
    // @which: 'a' or 'cc'
    // @state: true or false
    function setMaintainerCheckBox(email, which, state)
    {
        for (var i in maintElems[email][which])
        {
            maintElems[email][which][i].checked = state;
        }
    }

    // Set all maintainer 'a' or 'cc' checkboxes to a specific state,
    // then unset the second checkboxes if necessary.
    // @email: maintainer's email
    // @which: 'a' or 'cc', the one causing the change
    // @state: true or false
    function setBothMaintainerCheckBoxes(email, which, state)
    {
        setMaintainerCheckBox(email, which, state);
        if (state)
            setMaintainerCheckBox(email, which == 'a' ? 'cc' : 'a', !state);
    }

    // unset A states on all assignees except for the excluded one
    // but CC them if they were assignees before
    function clearAllOtherAssignees(exclude)
    {
        for (var m in maintElems)
        {
            if (m == exclude)
                continue;

            if (maintElems[m].a[0].checked)
            {
                setMaintainerCheckBox(m, 'cc', true);
                alterCCList(m, true);
            }
            setMaintainerCheckBox(m, 'a', false);
        }
    }

    // Alter the CC list on the bug to include/exclude specified email
    function alterCCList(email, state)
    {
        var unCCBox = document.getElementById('removecc');
        var foundInCC = false;
        if (unCCBox !== null)
        {
            var unCCList = document.querySelectorAll('#cc option');
            for (i = 0; i < unCCList.length; ++i)
            {
                if (unCCList[i].value == email)
                {
                    unCCList[i].selected = !state;
                    // if we want him removed, ensure the checkbox is checked
                    if (!state)
                        unCCBox.checked = true;
                    foundInCC = true;
                }
            }
        }

        var newCCInput = document.getElementById('newcc');
        if (newCCInput === null)
            newCCInput = document.getElementById('cc');
        var newCC = newCCInput.value.split(',');
        // first, clean up the list from any occurences of email
        newCC = newCC.filter(function (val) { return val.trim() != email; });
        // then, add just one if requested and not in CC already
        if (state && !foundInCC)
            newCC.push(email);
        // trim extra whitespace
        for (var i = 0; i < newCC.length; ++i)
            newCC[i] = newCC[i].trim();
        newCCInput.value = newCC.join(', ');
    }

    // Set new assignee for the bug
    function alterAssignee(value)
    {
        var assignInput = document.getElementById('assigned_to');
        assignInput.value = value;
        // expand the edit
        var editButton = document.getElementById('bz_assignee_edit_action');
        if (editButton !== null)
            editButton.click();
        var resetAssign = document.getElementById('set_default_assignee');
        if (resetAssign !== null)
            resetAssign.checked = false;
    }

    // Handle an explicit change of 'a' input
    function maintainerAssignExplicitChange(ev)
    {
        // update checkboxes!
        setBothMaintainerCheckBoxes(ev.target.email, 'a', ev.target.checked);
        clearAllOtherAssignees(ev.target.email);

        // set new assignee
        alterAssignee(ev.target.checked ? ev.target.email : '');

        // remove new assignee from CC
        if (ev.target.checked)
            alterCCList(ev.target.email, false);

        // always uncheck group controls
        ev.target.groupA.checked = false;
        ev.target.groupCC.checked = false;
    }

    // Handle an explicit change of 'cc' input
    function maintainerCCExplicitChange(ev)
    {
        // un-assign if he was an assignee
        if (maintElems[ev.target.email].a[0].checked)
            alterAssignee('');

        // update checkboxes!
        setBothMaintainerCheckBoxes(ev.target.email, 'cc', ev.target.checked);

        // update the CC list
        alterCCList(ev.target.email, ev.target.checked);

        // always uncheck group controls
        ev.target.groupA.checked = false;
        ev.target.groupCC.checked = false;
    }

    // Handle an explicit change of 'a' group
    function groupAssignExplicitChange(ev)
    {
        // store checked state as it will be cleaned
        var groupChecked = ev.target.checked;

        // mark all maintainers appropriately
        for (var i = 0; i < ev.target.maintainers.length; ++i)
        {
            var m = maintElems[ev.target.maintainers[i]];
            var mty;
            if (groupChecked)
                mty = i === 0 ? 'a' : 'cc';
            else
            {
                if (m.a[0].checked)
                    mty = 'a';
                else if (m.cc[0].checked)
                    mty = 'cc';
            }

            if (mty !== undefined)
            {
                m[mty][0].checked = groupChecked;
                if (mty == 'a')
                    maintainerAssignExplicitChange({'target': m[mty][0]});
                else
                    maintainerCCExplicitChange({'target': m[mty][0]});
            }
        }

        if (groupChecked)
        {
            // restore the checkbox and clean 'a' from other groups
            for (var pkg in maintGroups)
            {
                if (pkg == ev.target.pkg)
                    maintGroups[pkg].a.checked = true;
                else if (maintGroups[pkg].a.checked)
                {
                    maintGroups[pkg].a.checked = false;
                    maintGroups[pkg].cc.checked = true;
                }
            }
        }
    }

    // Handle an explicit change of 'cc' group
    function groupCCExplicitChange(ev)
    {
        // store checked state as it will be cleaned
        var groupChecked = ev.target.checked;

        // mark all maintainers appropriately
        for (var i = 0; i < ev.target.maintainers.length; ++i)
        {
            var m = maintElems[ev.target.maintainers[i]];
            var mty = m.a[0].checked ? 'a' : 'cc';

            m[mty][0].checked = groupChecked;
            if (mty == 'a')
                maintainerAssignExplicitChange({'target': m[mty][0]});
            else
                maintainerCCExplicitChange({'target': m[mty][0]});
        }

        // restore the checkbox
        if (groupChecked)
            maintGroups[ev.target.pkg].cc.checked = true;
    }

    // Update maintainer checkbox states according to bug info
    function syncMaintainerStatesToBug()
    {
        var i;

        // get the assignee
        var assignReset = document.getElementById('set_default_assignee');
        var assignInput = document.getElementById('assigned_to');
        var assignee;
        if (assignReset === null || !assignReset.checked)
            assignee = assignInput.value.trim();

        // get all CC-es into completeCCList
        var newCCInput = document.getElementById('newcc');
        if (newCCInput === null)
            newCCInput = document.getElementById('cc');
        var completeCCList = newCCInput.value.split(',');
        var unCCBox = document.getElementById('removecc');
        if (unCCBox !== null)
        {
            var unCCList = document.querySelectorAll('#cc option');
            for (i = 0; i < unCCList.length; ++i)
            {
                if (!(unCCList[i].selected && unCCBox.checked))
                    completeCCList.push(unCCList[i].value);
            }
        }

        // update maintainer states
        for (var m in maintElems)
        {
            var foundInCC = false;
            for (i = 0; i < completeCCList.length; ++i)
            {
                if (completeCCList[i] == m)
                    foundInCC = true;
            }

            // fun fact: here we can actually check box 'a' and 'cc'
            setMaintainerCheckBox(m, 'a', assignee == m);
            setMaintainerCheckBox(m, 'cc', foundInCC);
        }
    }

    // Issue an xmlHttpRequest for maintainers of package pkg
    // Triggers updateMaintainerTable() when all requests are finished
    function fetchMaintainersForPackage(pkg)
    {
        var xmlhttp = new XMLHttpRequest();
        xmlhttp.onreadystatechange = function() {
            if (xmlhttp.readyState == 4)
            {
                if (xmlhttp.status == 200)
                {
                    var json = JSON.parse(xmlhttp.responseText);
                    maintainers[json.atom] = json.maintainers;
                }
                else if (xmlhttp.status == 404)
                {
                }
                else
                {
                    // TODO: error handling
                }
                if (--reqInProgress === 0)
                    updateMaintainerTable();
            }
        };
        ++reqInProgress;
        xmlhttp.open('GET', 'https://packages.gentoo.org/packages/' + pkg + '.json', true);
        xmlhttp.send();
    }

    // trigger asynchronous maintainer list update
    function updatePackages()
    {
        var topbox = document.getElementById('bug-assign-table');
        packageList = getPackageNames();

        if (packageList.length === 0)
        {
            topbox.innerHTML = 'No packages found in summary';
            return;
        }

        // mark as being refreshed
        topbox.innerHTML = '<div>Update in progress...</div>' + topbox.innerHTML;
        maintainers = {};

        for (var i in packageList)
            fetchMaintainersForPackage(packageList[i]);
    }

    createBox();
    addTriggers();
    updatePackages();
})();