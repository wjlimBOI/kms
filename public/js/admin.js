(function() {
    'use strict';

    var isRedirecting = false;
    var refreshInterval = null;
    var isPageVisible = true;
    var auditSearchTimeout = null;
    var searchTimeout = null;

    var auditLogState = {
        page: 1,
        limit: 25,
        total: 0,
        data: [],
        filters: { action: '', user: '', target: '', from: '', to: '' }
    };

    var allTransactions = [];
    var filteredTransactions = [];
    var txPage = 1, txRows = 10, txTotal = 0;

    var inventoryData = [];
    var filteredInventory = [];
    var invPage = 1, invRows = 10, invTotal = 0;

    var manageKeyData = [];
    var manageKeyFiltered = [];
    var manageKeyPage = 1, manageKeyRows = 8, manageKeyTotal = 0;

    var permissionsData = { roles: [], permissions: [], roleMappings: {} };
    var allRolesList = [];
    var emailTabLoaded = false;
    var securityLoaded = false;
    var currentAction = null;
    var currentRequestId = null;

    if (!localStorage.getItem('kms_token') && !window.location.pathname.includes('/login')) {
        window.location.href = '/login';
        return;
    }

    function redirectToLogin() {
        if (isRedirecting) return;
        isRedirecting = true;
        localStorage.removeItem('kms_token');
        localStorage.removeItem('kms_user');
        sessionStorage.clear();
        document.cookie.split(";").forEach(function(c) {
            document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
        });
        window.location.href = '/login';
    }

    function getToken() { return localStorage.getItem('kms_token'); }

    function getUser() {
        try { return JSON.parse(localStorage.getItem('kms_user')); } catch (e) { return null; }
    }

    function escapeHtml(str) {
        if (!str) return '';
        var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;', '/': '&#x2F;' };
        return String(str).replace(/[&<>"'/]/g, function(m) { return map[m]; });
    }

    function formatDate(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleString('en-SG', {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    }

    function formatDateShort(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleDateString('en-SG', {
            year: 'numeric', month: 'short', day: 'numeric'
        });
    }

    function formatLastActive(iso) {
        if (!iso) return 'Never';
        return new Date(iso).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        }) + ' at ' + new Date(iso).toLocaleTimeString([], {
            hour: '2-digit', minute: '2-digit'
        });
    }

    function safeLower(value) {
        return (value || '').toString().toLowerCase();
    }

    function safeNumber(value, fallback) {
        fallback = fallback || 0;
        var num = parseFloat(value);
        return isNaN(num) ? fallback : num;
    }

    function statusBadgeHtml(status) {
        var map = {
            available: ['returned', 'Available'],
            borrowed: ['borrowed', 'Borrowed'],
            lost: ['lost', 'Lost'],
            unavailable: ['unavailable', 'Unavailable']
        };
        var data = map[status] || ['pending', status || 'Unknown'];
        return '<span class="status-badge ' + data[0] + '">' + data[1] + '</span>';
    }

    function updateNumber(id, value) {
        var el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    function showToast(message, type) {
        type = type || 'success';
        var root = document.getElementById('toastRoot');
        if (!root) {
            root = document.createElement('div');
            root.id = 'toastRoot';
            document.body.appendChild(root);
        }
        var toast = document.createElement('div');
        toast.className = 'toast-notification';
        toast.textContent = message;
        toast.style.background = type === 'error' ? '#EF4444' : type === 'warning' ? '#F59E0B' : '#1E293B';
        root.appendChild(toast);
        setTimeout(function() { toast.remove(); }, 3000);
    }

    function showAlertModal(message, type, title) {
        type = type || 'success';
        var modal = document.getElementById('alertModal');
        if (!modal) return;

        var icon = document.getElementById('alertIcon');
        var titleEl = document.getElementById('alertTitle');
        var msgEl = document.getElementById('alertMessage');
        if (!icon || !titleEl || !msgEl) return;

        icon.className = 'alert-icon';
        var titles = { success: 'Success', error: 'Error', warning: 'Warning', info: 'Information' };
        var icons = {
            success: 'fa-check-circle',
            error: 'fa-times-circle',
            warning: 'fa-exclamation-triangle',
            info: 'fa-info-circle'
        };
        var classes = { success: 'success', error: 'error', warning: 'warning', info: 'info' };

        icon.classList.add(classes[type] || 'success');
        icon.innerHTML = '<i class="fas ' + (icons[type] || icons.success) + '"></i>';
        titleEl.textContent = title || titles[type] || 'Notice';
        msgEl.textContent = message;

        modal.classList.add('active');
        modal.style.display = 'flex';
    }

    function closeAlertModal() {
        var modal = document.getElementById('alertModal');
        if (modal) {
            modal.classList.remove('active');
            modal.style.display = 'none';
        }
    }

    function showDetailModal(title, contentHtml) {
        document.getElementById('detailModalTitle').innerText = title;
        document.getElementById('detailModalContent').innerHTML = contentHtml;
        document.getElementById('detailModal').style.display = 'flex';
    }

    function closeDetailModal() {
        document.getElementById('detailModal').style.display = 'none';
    }

    function openPortalMenu(triggerEl, menuHtml, onRender) {
        document.querySelectorAll('.portal-menu').forEach(function(m) { m.remove(); });
        var menu = document.createElement('div');
        menu.className = 'portal-menu';
        menu.innerHTML = menuHtml;
        document.body.appendChild(menu);

        var rect = triggerEl.getBoundingClientRect();
        var menuWidth = menu.offsetWidth || 200;
        var left = rect.right - menuWidth;
        if (left < 8) left = rect.left;
        var top = rect.bottom + 6;
        if (top + menu.offsetHeight > window.innerHeight - 8) {
            top = rect.top - menu.offsetHeight - 6;
        }
        menu.style.left = Math.max(8, left) + 'px';
        menu.style.top = Math.max(8, top) + 'px';
        menu.style.zIndex = '1000000';

        if (onRender) onRender(menu);

        var closeMenu = function(e) {
            if (!menu.contains(e.target) && e.target !== triggerEl && !triggerEl.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu, true);
                window.removeEventListener('scroll', reposition, true);
                window.removeEventListener('resize', reposition);
            }
        };
        var reposition = function() { menu.remove(); };

        setTimeout(function() { document.addEventListener('click', closeMenu, true); }, 0);
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);

        return menu;
    }

    function showConfirm(message, options) {
        options = options || {};
        var title = options.title || 'Please confirm';
        var danger = options.danger !== undefined ? options.danger : true;
        var okLabel = options.okLabel || 'Confirm';

        return new Promise(function(resolve) {
            var modal = document.getElementById('execConfirmModal');
            var icon = document.getElementById('execConfirmIcon');
            var okBtn = document.getElementById('execConfirmOkBtn');
            var cancelBtn = document.getElementById('execConfirmCancelBtn');

            document.getElementById('execConfirmTitle').textContent = title;
            document.getElementById('execConfirmMessage').textContent = message;
            icon.className = 'exec-confirm-icon' + (danger ? ' danger' : '');
            icon.innerHTML = danger ? '<i class="fas fa-exclamation-triangle"></i>' : '<i class="fas fa-question"></i>';
            okBtn.textContent = okLabel;
            okBtn.className = 'btn ' + (danger ? 'btn-critical' : 'btn-primary');

            modal.classList.add('active');
            modal.style.display = 'flex';
            modal.style.zIndex = '1000001';

            var cleanup = function(result) {
                modal.classList.remove('active');
                modal.style.display = 'none';
                modal.style.zIndex = '';
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                modal.removeEventListener('click', onOverlay);
                resolve(result);
            };
            var onOk = function() { cleanup(true); };
            var onCancel = function() { cleanup(false); };
            var onOverlay = function(e) { if (e.target === modal) cleanup(false); };

            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            modal.addEventListener('click', onOverlay);
        });
    }

    function showPromptModal(message, options) {
        options = options || {};
        var title = options.title || 'Add a note';
        var placeholder = options.placeholder || 'Optional notes...';
        var required = options.required || false;

        return new Promise(function(resolve) {
            var modal = document.getElementById('execPromptModal');
            var input = document.getElementById('execPromptInput');
            var okBtn = document.getElementById('execPromptOkBtn');
            var cancelBtn = document.getElementById('execPromptCancelBtn');
            var closeBtn = document.getElementById('execPromptCloseBtn');

            document.getElementById('execPromptTitle').textContent = title;
            document.getElementById('execPromptMessage').textContent = message;
            input.value = '';
            input.placeholder = placeholder;
            input.style.borderColor = '';
            modal.classList.add('active');
            modal.style.display = 'flex';
            modal.style.zIndex = '1000001';
            setTimeout(function() { input.focus(); }, 50);

            var cleanup = function(result) {
                modal.classList.remove('active');
                modal.style.display = 'none';
                modal.style.zIndex = '';
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                closeBtn.removeEventListener('click', onCancel);
                modal.removeEventListener('click', onOverlay);
                resolve(result);
            };
            var onOk = function() {
                var val = input.value.trim();
                if (required && !val) {
                    input.style.borderColor = '#dc2626';
                    return;
                }
                cleanup(val || null);
            };
            var onCancel = function() { cleanup(undefined); };
            var onOverlay = function(e) { if (e.target === modal) cleanup(undefined); };

            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            closeBtn.addEventListener('click', onCancel);
            modal.addEventListener('click', onOverlay);
        });
    }

    function printSection(containerId) {
        var container = document.getElementById(containerId);
        if (!container) return;
        var clone = container.cloneNode(true);
        clone.querySelectorAll('.btn-print').forEach(function(el) { el.remove(); });
        var header = clone.querySelector('.card-header');
        if (header) {
            header.querySelectorAll('.btn-print, .btn-manage, .btn-refresh, input, select, button').forEach(function(el) { el.remove(); });
        }
        clone.querySelectorAll('.grid, .search-bar, .flex.gap-2.justify-end').forEach(function(el) { el.remove(); });

        var styles = document.querySelector('style') ? document.querySelector('style').innerHTML : '';
        var width = Math.min(1200, screen.width - 40);
        var height = Math.min(800, screen.height - 80);
        var printWin = window.open('', '_blank', 'width=' + width + ',height=' + height);
        printWin.document.write('<!DOCTYPE html><html><head><title>Print</title><style>'
            + '* { box-sizing: border-box; } body { font-family: "Inter", sans-serif; background: white; padding: 2rem; } '
            + '.container { max-width: 1200px; margin: 0 auto; } .card-header { background: #f8fafc; padding: 0.75rem 1.125rem; border-bottom: 2px solid #d4a843; } '
            + '.card-header h3 { margin: 0; font-size: 1rem; } .card-body { padding: 1rem 1.125rem; } table { width: 100%; border-collapse: collapse; font-size: 0.8rem; } '
            + 'th { background: #f1f5f9; text-align: left; padding: 0.5rem; border-bottom: 2px solid #e2e8f0; } td { padding: 0.5rem; border-bottom: 1px solid #e2e8f0; } '
            + '.status-badge { padding: 0.1rem 0.6rem; border-radius: 40px; font-size: 0.7rem; display: inline-block; } .no-print { display: none !important; } '
            + '@page { margin: 1.5cm; } ' + styles
            + '</style></head><body><div class="container">' + clone.outerHTML + '</div><script>window.onload = function() { window.print(); window.close(); };<\/script></body></html>');
        printWin.document.close();
    }

    // ==================== AUTHENTICATED FETCH ====================
    async function authenticatedFetch(url, options) {
        options = options || {};
        var token = getToken();
        if (!token) {
            if (!isRedirecting) redirectToLogin();
            throw new Error('No authentication token found. Please log in again.');
        }

        var csrf = await getCsrfToken() || '';
        var headers = {
            'Authorization': 'Bearer ' + token,
            'X-CSRF-Token': csrf,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json'
        };
        for (var key in options.headers) {
            if (options.headers.hasOwnProperty(key)) {
                headers[key] = options.headers[key];
            }
        }

        if (options.body && !(options.body instanceof FormData)) {
            headers['Content-Type'] = 'application/json';
        }
        if (options.body instanceof FormData) {
            delete headers['Content-Type'];
        }

        var fetchOptions = {
            method: options.method || 'GET',
            headers: headers,
            credentials: 'include'
        };
        if (options.body && !(options.body instanceof FormData)) {
            fetchOptions.body = JSON.stringify(options.body);
        } else if (options.body instanceof FormData) {
            fetchOptions.body = options.body;
        }
        if (options.signal) {
            fetchOptions.signal = options.signal;
        }
        if (options.method === 'GET') {
            delete fetchOptions.body;
        }

        try {
            var response = await fetch(url, fetchOptions);

            if (response.status === 403) {
                var errorData = await response.json().catch(function() { return {}; });
                if (errorData.error === 'Invalid CSRF token' || errorData.code === 'INVALID_CSRF') {
                    var newCsrf = await refreshCsrfToken();
                    if (newCsrf) {
                        headers['X-CSRF-Token'] = newCsrf;
                        var retryOptions = {
                            method: options.method || 'GET',
                            headers: headers,
                            credentials: 'include'
                        };
                        if (options.body && !(options.body instanceof FormData)) {
                            retryOptions.body = JSON.stringify(options.body);
                        } else if (options.body instanceof FormData) {
                            retryOptions.body = options.body;
                        }
                        if (options.method === 'GET') {
                            delete retryOptions.body;
                        }
                        response = await fetch(url, retryOptions);
                    }
                }
            }

            if (response.status === 401) {
                if (!isRedirecting) redirectToLogin();
                throw new Error('Your session has expired. Please log in again.');
            }

            return response;
        } catch (err) {
            if (err.name === 'TypeError' && err.message.indexOf('fetch') !== -1) {
                throw new Error('Unable to connect to the server. Please check your internet connection and try again.');
            }
            throw err;
        }
    }

    // ==================== CSRF ====================
    var csrfToken = null;
    var csrfFetchPromise = null;

    async function fetchCsrfToken() {
        if (csrfFetchPromise) return csrfFetchPromise;
        csrfFetchPromise = (async function() {
            try {
                var response = await fetch('/api/csrf-token', {
                    credentials: 'include',
                    headers: { 'Accept': 'application/json' }
                });
                if (response.ok) {
                    var data = await response.json();
                    csrfToken = data.csrfToken;
                    return csrfToken;
                }
                return null;
            } catch (error) {
                console.error('Error fetching CSRF token:', error);
                return null;
            } finally {
                csrfFetchPromise = null;
            }
        })();
        return csrfFetchPromise;
    }

    async function getCsrfToken() {
        if (csrfToken) return csrfToken;
        return await fetchCsrfToken();
    }

    async function refreshCsrfToken() {
        csrfToken = null;
        csrfFetchPromise = null;
        return await fetchCsrfToken();
    }

    async function ensureCsrfToken() {
        var token = await getCsrfToken();
        var meta = document.querySelector('meta[name="csrf-token"]');
        if (meta && token) meta.setAttribute('content', token);
        return token;
    }

    // ==================== AUDIT ====================
    async function loadAuditLogs(page, limit) {
        page = page || auditLogState.page;
        limit = limit || auditLogState.limit;

        if (typeof limit === 'string') {
            limit = parseInt(limit, 10);
        }
        if (isNaN(limit) || limit < 1) {
            limit = 25;
        }

        auditLogState.page = page;
        auditLogState.limit = limit;

        var container = document.getElementById('auditLogContainer');
        var totalSpan = document.getElementById('auditTotalCount');
        var infoSpan = document.getElementById('auditPaginationInfo');
        var pageInfoSpan = document.getElementById('auditPageInfo');
        var prevBtn = document.getElementById('auditPrevPageBtn');
        var nextBtn = document.getElementById('auditNextPageBtn');

        if (!container) return;

        container.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-slate-400"><div class="skeleton h-8 w-full"></div></td></tr>';

        try {
            var params = new URLSearchParams({
                page: auditLogState.page,
                limit: auditLogState.limit
            });

            if (auditLogState.filters.action) params.append('action', auditLogState.filters.action);
            if (auditLogState.filters.user) params.append('user', auditLogState.filters.user);
            if (auditLogState.filters.target) params.append('target', auditLogState.filters.target);
            if (auditLogState.filters.from) params.append('from', auditLogState.filters.from);
            if (auditLogState.filters.to) params.append('to', auditLogState.filters.to);

            var res = await authenticatedFetch('/api/audit/logs?' + params.toString());

            if (!res.ok) {
                throw new Error('Failed to load audit logs');
            }

            var result = await res.json();

            var logs = [];
            var total = 0;

            if (result.data && Array.isArray(result.data)) {
                logs = result.data;
                total = result.total || logs.length;
            } else if (Array.isArray(result)) {
                logs = result;
                total = logs.length;
            } else {
                logs = [];
                total = 0;
            }

            auditLogState.data = logs;
            auditLogState.total = total;

            if (totalSpan) {
                totalSpan.textContent = 'Total: ' + total + ' entries';
            }

            var start = (auditLogState.page - 1) * auditLogState.limit + 1;
            var end = Math.min(start + auditLogState.limit - 1, total);

            if (infoSpan) {
                if (total === 0) {
                    infoSpan.textContent = 'Showing 0 of 0 entries';
                } else {
                    infoSpan.textContent = 'Showing ' + start + ' to ' + end + ' of ' + total + ' entries';
                }
            }

            var totalPages = Math.ceil(total / auditLogState.limit) || 1;
            if (pageInfoSpan) {
                pageInfoSpan.textContent = 'Page ' + auditLogState.page + ' of ' + totalPages;
            }

            if (prevBtn) {
                prevBtn.disabled = auditLogState.page <= 1 || total === 0;
            }
            if (nextBtn) {
                nextBtn.disabled = auditLogState.page >= totalPages || total === 0;
            }

            if (logs.length === 0) {
                container.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-slate-400">No audit logs found.</td></tr>';
            } else {
                var html = '';
                for (var i = 0; i < logs.length; i++) {
                    var log = logs[i];
                    html += '<tr class="audit-row" data-log-id="' + (log.id || '') + '">'
                        + '<td class="action-cell">' + escapeHtml(log.action || '') + '</td>'
                        + '<td class="target-cell">' + escapeHtml(log.target || log.target_type || '') + '</td>'
                        + '<td class="user-cell">' + escapeHtml(log.user_name || log.user_email || 'Unknown') + '</td>'
                        + '<td class="time-cell">' + (log.created_at ? formatDate(log.created_at) : '—') + '</td>'
                        + '</tr>';
                }
                container.innerHTML = html;

                container.querySelectorAll('.audit-row').forEach(function(row) {
                    row.addEventListener('click', function() {
                        var logId = this.dataset.logId;
                        if (logId) {
                            showAuditLogDetail(logId);
                        }
                    });
                });
            }

        } catch (error) {
            console.error('Error loading audit logs:', error);
            container.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-rose-600">Error loading audit logs: ' + escapeHtml(error.message) + '</td></tr>';
            showToast('Failed to load audit logs', 'error');
        }
    }

    async function showAuditLogDetail(logId) {
        try {
            var res = await authenticatedFetch('/api/audit/logs/' + logId);
            if (!res.ok) {
                throw new Error('Failed to load log details');
            }
            var log = await res.json();

            var modal = document.getElementById('detailModal');
            var title = document.getElementById('detailModalTitle');
            var content = document.getElementById('detailModalContent');

            title.textContent = 'Audit Log Details';

            var detailsHtml = '<div class="detail-grid">'
                + '<div class="detail-section full-width"><div class="detail-label">Action</div><div class="detail-value">' + escapeHtml(log.action || '—') + '</div></div>'
                + '<div class="detail-section"><div class="detail-label">Target</div><div class="detail-value">' + escapeHtml(log.target || log.target_type || '—') + '</div></div>'
                + '<div class="detail-section"><div class="detail-label">User</div><div class="detail-value">' + escapeHtml(log.user_name || log.user_email || '—') + '</div></div>'
                + '<div class="detail-section"><div class="detail-label">Timestamp</div><div class="detail-value">' + (log.created_at ? formatDate(log.created_at) : '—') + '</div></div>'
                + '<div class="detail-section full-width"><div class="detail-label">IP Address</div><div class="detail-value">' + escapeHtml(log.ip_address || '—') + '</div></div>'
                + '<div class="detail-section full-width"><div class="detail-label">Details</div><div class="detail-value"><pre>' + escapeHtml(typeof log.details === 'string' ? log.details : JSON.stringify(log.details || {}, null, 2)) + '</pre></div></div>'
                + '</div>';

            content.innerHTML = detailsHtml;
            modal.style.display = 'flex';

        } catch (error) {
            console.error('Error loading audit log detail:', error);
            showToast('Failed to load log details', 'error');
        }
    }

    function initAuditLogFilters() {
        var searchBtn = document.getElementById('auditSearchBtn');
        var resetBtn = document.getElementById('auditResetBtn');
        var refreshBtn = document.getElementById('refreshAuditLogBtn');
        var rowsPerPage = document.getElementById('auditRowsPerPage');
        var prevBtn = document.getElementById('auditPrevPageBtn');
        var nextBtn = document.getElementById('auditNextPageBtn');

        if (searchBtn) {
            searchBtn.addEventListener('click', function() {
                auditLogState.filters.action = document.getElementById('auditFilterAction').value.trim();
                auditLogState.filters.user = document.getElementById('auditFilterUser').value.trim();
                auditLogState.filters.target = document.getElementById('auditFilterTarget').value.trim();
                auditLogState.filters.from = document.getElementById('auditFilterFrom').value;
                auditLogState.filters.to = document.getElementById('auditFilterTo').value;
                auditLogState.page = 1;
                loadAuditLogs();
            });
        }

        if (resetBtn) {
            resetBtn.addEventListener('click', function() {
                document.getElementById('auditFilterAction').value = '';
                document.getElementById('auditFilterUser').value = '';
                document.getElementById('auditFilterTarget').value = '';
                document.getElementById('auditFilterFrom').value = '';
                document.getElementById('auditFilterTo').value = '';
                auditLogState.filters = { action: '', user: '', target: '', from: '', to: '' };
                auditLogState.page = 1;
                loadAuditLogs();
            });
        }

        if (refreshBtn) {
            refreshBtn.addEventListener('click', function() {
                var originalHtml = this.innerHTML;
                this.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                this.disabled = true;
                loadAuditLogs().finally(function() {
                    refreshBtn.innerHTML = originalHtml;
                    refreshBtn.disabled = false;
                });
            });
        }

        if (rowsPerPage) {
            rowsPerPage.addEventListener('change', function() {
                var newLimit = parseInt(this.value, 10);
                if (isNaN(newLimit) || newLimit < 1) {
                    newLimit = 25;
                }
                auditLogState.limit = newLimit;
                auditLogState.page = 1;
                loadAuditLogs();
            });
        }

        if (prevBtn) {
            prevBtn.addEventListener('click', function() {
                if (auditLogState.page > 1) {
                    auditLogState.page--;
                    loadAuditLogs();
                }
            });
        }

        if (nextBtn) {
            nextBtn.addEventListener('click', function() {
                var totalPages = Math.ceil(auditLogState.total / auditLogState.limit);
                if (auditLogState.page < totalPages) {
                    auditLogState.page++;
                    loadAuditLogs();
                }
            });
        }

        document.querySelectorAll('#auditFilterAction, #auditFilterUser, #auditFilterTarget, #auditFilterFrom, #auditFilterTo').forEach(function(input) {
            input.addEventListener('input', function() {
                if (auditSearchTimeout) {
                    clearTimeout(auditSearchTimeout);
                }
                auditSearchTimeout = setTimeout(function() {
                    if (searchBtn) {
                        searchBtn.click();
                    }
                }, 500);
            });

            input.addEventListener('keypress', function(e) {
                if (e.key === 'Enter' && searchBtn) {
                    if (auditSearchTimeout) {
                        clearTimeout(auditSearchTimeout);
                    }
                    searchBtn.click();
                }
            });
        });
    }

    async function loadAuditHealth() {
        try {
            var res = await authenticatedFetch('/api/admin/audit-health');
            var data = await res.json();
            var text = document.getElementById('auditStatusText');
            var last = document.getElementById('auditLastCheck');

            if (data.status === 'ok') {
                text.innerHTML = '✅ Chain intact';
                text.className = 'text-sm font-medium text-emerald-600';
            } else if (data.status === 'tampered') {
                text.innerHTML = '⚠️ TAMPER DETECTED';
                text.className = 'text-sm font-medium text-rose-600';
            } else if (data.status === 'error') {
                text.innerHTML = '⚠️ Validation error';
                text.className = 'text-sm font-medium text-amber-600';
            } else {
                text.innerHTML = 'Unknown';
                text.className = 'text-sm font-medium text-slate-500';
            }
            last.innerText = data.checked_at ? 'Last check: ' + formatDate(data.checked_at) : 'Last check: --';
        } catch (err) {
            document.getElementById('auditStatusText').innerHTML = '❌ Unable to verify audit integrity. Please refresh.';
            showAlertModal(err.message || 'Failed to load audit health status.', 'error');
        }
    }

    // ==================== TRANSACTIONS ====================
    async function loadTransactions() {
        var giver = document.getElementById('filterGiver') ? document.getElementById('filterGiver').value.trim() : '';
        var receiver = document.getElementById('filterReceiver') ? document.getElementById('filterReceiver').value.trim() : '';
        var branch = document.getElementById('filterBranch') ? document.getElementById('filterBranch').value.trim() : '';
        var action = document.getElementById('filterAction') ? document.getElementById('filterAction').value.trim() : '';
        var status = document.getElementById('filterStatus') ? document.getElementById('filterStatus').value : '';
        var from = document.getElementById('filterFrom') ? document.getElementById('filterFrom').value : '';
        var to = document.getElementById('filterTo') ? document.getElementById('filterTo').value : '';

        var params = new URLSearchParams();
        if (giver) params.append('giver', giver);
        if (receiver) params.append('receiver', receiver);
        if (branch) params.append('branch', branch);
        if (action) params.append('action', action);
        if (status) params.append('status', status);
        if (from) params.append('from', from);
        if (to) params.append('to', to);
        params.append('page', txPage);
        params.append('limit', txRows);

        try {
            var res = await authenticatedFetch('/api/admin/transactions?' + params.toString());
            var data = await res.json();
            allTransactions = data.data || [];
            txTotal = data.pagination ? data.pagination.total : 0;
            applyTransactionFilters();
            updateMetrics(allTransactions);
            window._activeBorrowsData = allTransactions.filter(function(t) { return t.status === 'borrowed'; });
        } catch (err) {
            document.getElementById('transactionsTableBody').innerHTML =
                '<tr><td colspan="10" class="text-center py-8 text-slate-400">Unable to load transactions. Please refresh the page.</td></tr>';
            showAlertModal(err.message || 'Failed to load transactions.', 'error');
        }
    }

    function applyTransactionFilters() {
        filteredTransactions = allTransactions;
        renderTransactionsTable();
        updateTransactionPagination();
    }

    function renderTransactionsTable() {
        var tbody = document.getElementById('transactionsTableBody');
        var start = (txPage - 1) * txRows;
        var end = Math.min(start + txRows, txTotal);
        var pageData = filteredTransactions.slice(start, end);

        if (!pageData.length) {
            tbody.innerHTML = '<tr><td colspan="10" class="text-center py-8 text-slate-400">No transactions found.</td></tr>';
            return;
        }

        var html = '';
        for (var i = 0; i < pageData.length; i++) {
            var tx = pageData[i];
            var statusClass = tx.status === 'borrowed' ? 'borrowed' : tx.status === 'returned' ? 'returned' : tx.status === 'lost' ? 'lost' : '';
            html += '<tr><td>' + escapeHtml(tx.id) + '</td>'
                + '<td>' + escapeHtml(tx.giver_signature_name || '—') + '</td>'
                + '<td>' + escapeHtml(tx.receiver_signature_name || '—') + '</td>'
                + '<td>' + escapeHtml(tx.key_code || '—') + '</td>'
                + '<td>' + escapeHtml(tx.quantity) + '</td>'
                + '<td>' + (tx.action === 'borrow' ? 'Withdraw' : 'Return') + '</td>'
                + '<td>' + formatDate(tx.borrowed_at) + '</td>'
                + '<td>' + formatDate(tx.returned_at) + '</td>'
                + '<td><span class="status-badge ' + statusClass + '">' + tx.status + '</span></td>'
                + '<td>' + escapeHtml(tx.reason || '—') + '</td></tr>';
        }
        tbody.innerHTML = html;
    }

    function updateTransactionPagination() {
        var totalPages = Math.ceil(txTotal / txRows) || 1;
        var start = (txPage - 1) * txRows + 1;
        var end = Math.min(txPage * txRows, txTotal);
        document.getElementById('transactionsPaginationInfo').innerText = txTotal === 0 ?
            'Showing 0 of 0 transactions' :
            'Showing ' + start + '–' + end + ' of ' + txTotal + ' transactions';
        document.getElementById('transactionsPrevPageBtn').disabled = txPage === 1 || txTotal === 0;
        document.getElementById('transactionsNextPageBtn').disabled = txPage >= totalPages || txTotal === 0;
    }

    function updateMetrics(transactions) {
        var active = transactions.filter(function(t) { return t.status === 'borrowed'; });
        updateNumber('borrowedCount', active.length);

        var withReturn = transactions.filter(function(t) { return t.status === 'borrowed' && t.planned_return; });
        var today = new Date();
        today.setHours(0, 0, 0, 0);

        var overdue = withReturn.filter(function(t) {
            var d = new Date(t.planned_return);
            d.setHours(0, 0, 0, 0);
            return d < today;
        });
        var dueToday = withReturn.filter(function(t) {
            var d = new Date(t.planned_return);
            d.setHours(0, 0, 0, 0);
            return d.getTime() === today.getTime();
        });
        updateNumber('overdueCount', overdue.length + dueToday.length);

        var next = null;
        if (withReturn.length) {
            next = withReturn.reduce(function(a, b) {
                return new Date(a.planned_return) < new Date(b.planned_return) ? a : b;
            });
        }
        document.getElementById('reminderNextDue').innerText = next ? 'Next due: ' + formatDateShort(next.planned_return) : 'Next due: --';
    }

    // ==================== PENDING KEY REQUESTS ====================
    async function loadPendingRequests() {
        try {
            var res = await authenticatedFetch('/api/admin/requests/pending');
            var data = await res.json();
            updateNumber('pendingCount', data.length);
            updateNumber('pendingKeyRequestsCount', data.length);
            window._pendingRequestsData = data;
        } catch (err) {
            updateNumber('pendingCount', 0);
            updateNumber('pendingKeyRequestsCount', 0);
            showAlertModal(err.message || 'Unable to load pending requests.', 'error');
        }
    }

    function showPendingRequestsModal() {
        var data = window._pendingRequestsData || [];
        if (!data.length) {
            showDetailModal('Pending Requests', '<div class="text-center py-8 text-slate-400">No pending requests.</div>');
            return;
        }
        var rows = '';
        for (var i = 0; i < data.length; i++) {
            var req = data[i];
            var keyList = req.key_details ? req.key_details.map(function(k) { return k.code + ' x' + k.quantity; }).join(', ') : '—';
            rows += '<tr><td>' + escapeHtml(req.requester_name) + '</td>'
                + '<td>' + escapeHtml(req.requester_email) + '</td>'
                + '<td>' + escapeHtml(keyList) + '</td>'
                + '<td>' + formatDate(req.planned_return) + '</td>'
                + '<td><button class="btn btn-sm btn-ghost request-actions-btn" data-id="' + req.id + '" data-name="' + escapeHtml(req.requester_name) + '"><i class="fas fa-ellipsis-v"></i></button></td></tr>';
        }
        showDetailModal('Pending Requests', '<table class="table-clean"><thead><tr><th>Requester</th><th>Email</th><th>Keys</th><th>Planned Return</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table>');

        document.querySelectorAll('#detailModalContent .request-actions-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var id = parseInt(this.dataset.id);
                var name = this.dataset.name;

                var menuHtml = '<button class="menu-item approve-request" data-id="' + id + '"><i class="fas fa-check-circle"></i> Approve Request</button>'
                    + '<button class="menu-item danger reject-request" data-id="' + id + '"><i class="fas fa-times-circle"></i> Reject Request</button>';

                openPortalMenu(this, menuHtml, function(menu) {
                    menu.querySelector('.approve-request').addEventListener('click', function() {
                        menu.remove();
                        currentAction = 'approve';
                        currentRequestId = id;
                        document.getElementById('modalTitle').textContent = 'Approve request from ' + name;
                        document.getElementById('modalNotes').value = '';
                        document.getElementById('adminModal').style.display = 'flex';
                        closeDetailModal();
                    });

                    menu.querySelector('.reject-request').addEventListener('click', function() {
                        menu.remove();
                        currentAction = 'deny';
                        currentRequestId = id;
                        document.getElementById('modalTitle').textContent = 'Reject request from ' + name;
                        document.getElementById('modalNotes').value = '';
                        document.getElementById('adminModal').style.display = 'flex';
                        closeDetailModal();
                    });
                });
            });
        });
    }

    // ==================== PENDING RETURNS ====================
    async function loadPendingReturns() {
        try {
            var res = await authenticatedFetch('/api/return/pending');
            var data = await res.json();
            updateNumber('pendingReturnsCount', data.length);
            window._pendingReturnsData = data;
        } catch (err) {
            updateNumber('pendingReturnsCount', 0);
            showAlertModal(err.message || 'Unable to load pending returns.', 'error');
        }
    }

    function showPendingReturnsModal() {
        var data = window._pendingReturnsData || [];
        if (!data.length) {
            showDetailModal('Pending Returns', '<div class="text-center py-8 text-slate-400">No pending returns.</div>');
            return;
        }
        var rows = '';
        for (var i = 0; i < data.length; i++) {
            var ret = data[i];
            rows += '<tr><td>' + escapeHtml(ret.requester_name || ret.requester_email) + '</td>'
                + '<td>' + escapeHtml(ret.key_list) + '</td>'
                + '<td>' + formatDate(ret.created_at) + '</td>'
                + '<td><button class="btn btn-success btn-sm approveReturnModalBtn" data-id="' + ret.id + '"><i class="fas fa-check"></i> Verify</button></td></tr>';
        }
        showDetailModal('Pending Returns', '<table class="table-clean"><thead><tr><th>Requester</th><th>Keys</th><th>Requested</th><th>Action</th></tr></thead><tbody>' + rows + '</tbody></table>');

        document.querySelectorAll('.approveReturnModalBtn').forEach(function(btn) {
            btn.addEventListener('click', async function() {
                var id = parseInt(this.dataset.id);
                try {
                    var res = await authenticatedFetch('/api/return/verify', {
                        method: 'POST',
                        body: { return_request_id: id }
                    });
                    if (res.ok) {
                        showAlertModal('Return verified successfully.', 'success');
                        closeDetailModal();
                        loadPendingReturns();
                        loadTransactions();
                    } else {
                        var data = await res.json();
                        showAlertModal(data.error || 'Verification failed.', 'error');
                    }
                } catch (err) {
                    showAlertModal(err.message || 'Network error.', 'error');
                }
            });
        });
    }

    // ==================== LOST KEYS ====================
    async function loadLostKeys() {
        try {
            var res = await authenticatedFetch('/api/admin/lost-keys');
            var data = await res.json();
            updateNumber('lostKeysCount', data.length);
            window._lostKeysData = data;
        } catch (err) {
            updateNumber('lostKeysCount', 0);
            showAlertModal(err.message || 'Unable to load lost keys.', 'error');
        }
    }

    function showLostKeysModal() {
        var data = window._lostKeysData || [];
        if (!data.length) {
            showDetailModal('Lost Keys', '<div class="text-center py-8 text-slate-400">No lost keys.</div>');
            return;
        }
        var rows = '';
        for (var i = 0; i < data.length; i++) {
            var item = data[i];
            var statusClass = item.resolved_at ? 'returned' : 'lost';
            var statusLabel = item.resolved_at ? 'Resolved' : 'Lost';
            rows += '<tr class="lost-key-row" data-tx-id="' + item.id + '">'
                + '<td><code>' + escapeHtml(item.key_code) + '</code></td>'
                + '<td>' + escapeHtml(item.brand) + '</td>'
                + '<td>' + escapeHtml(item.borrower_name || item.borrower_email) + '</td>'
                + '<td>' + formatDate(item.lost_at) + '</td>'
                + '<td><span class="status-badge ' + statusClass + '">' + statusLabel + '</span></td>'
                + '<td><button class="btn btn-sm btn-ghost lost-actions-btn" data-tx-id="' + item.id + '"><i class="fas fa-ellipsis-v"></i></button></td></tr>';
        }
        showDetailModal('Lost Keys', '<table class="table-clean"><thead><tr><th>Key</th><th>Brand</th><th>Borrower</th><th>Lost Date</th><th>Status</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table>');

        document.querySelectorAll('#detailModalContent .lost-actions-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var txId = parseInt(this.dataset.txId);
                var lostItem = null;
                if (window._lostKeysData) {
                    for (var j = 0; j < window._lostKeysData.length; j++) {
                        if (window._lostKeysData[j].id === txId) {
                            lostItem = window._lostKeysData[j];
                            break;
                        }
                    }
                }
                if (!lostItem) return;

                var menuHtml = '<button class="menu-item" data-action="view"><i class="fas fa-eye"></i> View Details</button>'
                    + '<button class="menu-item" data-action="edit"><i class="fas fa-edit"></i> Edit</button><div class="menu-divider"></div>';

                if (!lostItem.fine_id && !lostItem.resolved_at) {
                    menuHtml += '<button class="menu-item" data-action="create-fine"><i class="fas fa-plus-circle"></i> Create Fee</button>';
                }
                if (!lostItem.resolved_at) {
                    menuHtml += '<button class="menu-item" data-action="close-ticket"><i class="fas fa-check-circle"></i> Close Ticket</button>';
                }
                menuHtml += '<button class="menu-item" data-action="make-available"><i class="fas fa-check"></i> Make Available</button>';

                if (lostItem.fine_id && lostItem.fine_status === 'pending') {
                    menuHtml += '<div class="menu-divider"></div>'
                        + '<button class="menu-item" data-action="mark-paid"><i class="fas fa-dollar-sign"></i> Mark Paid</button>'
                        + '<button class="menu-item" data-action="waive"><i class="fas fa-handshake"></i> Waive Fee</button>';
                }

                openPortalMenu(this, menuHtml, function(menu) {
                    menu.querySelectorAll('.menu-item[data-action]').forEach(function(item) {
                        item.addEventListener('click', function() {
                            var action = this.dataset.action;
                            menu.remove();
                            executeLostKeyAction(action, lostItem);
                        });
                    });
                });
            });
        });
    }

    async function executeLostKeyAction(action, item) {
        var keyCode = item.key_code || 'unknown';

        switch (action) {
            case 'view':
                showLostKeyDetailFromItem(item);
                break;
            case 'edit':
                openLostKeyEditModal(item.id);
                break;
            case 'create-fine': {
                var ok = await showConfirm('Create a $50 fee for lost key ' + keyCode + '?', {
                    title: 'Create Fee',
                    danger: false,
                    okLabel: 'Create Fee'
                });
                if (!ok) return;
                try {
                    var res = await authenticatedFetch('/api/admin/lost-keys/' + item.id + '/create-fine', { method: 'POST' });
                    var data = await res.json();
                    if (res.ok) {
                        showAlertModal('Fee created successfully.', 'success');
                        closeDetailModal();
                        await loadLostKeys();
                        await loadTransactions();
                        await loadLostKeysManagement();
                    } else {
                        showAlertModal(data.error || 'Failed to create fee.', 'error');
                    }
                } catch (err) {
                    showAlertModal(err.message || 'Network error.', 'error');
                }
                break;
            }
            case 'mark-paid': {
                var ok = await showConfirm('Mark fee for ' + keyCode + ' as paid?', {
                    title: 'Confirm Payment',
                    danger: false,
                    okLabel: 'Mark Paid'
                });
                if (!ok) return;
                try {
                    var res = await authenticatedFetch('/api/admin/fines/' + item.fine_id + '/paid', { method: 'POST' });
                    if (res.ok) {
                        showAlertModal('Fee marked paid.', 'success');
                        closeDetailModal();
                        await loadLostKeys();
                        await loadTransactions();
                        await loadLostKeysManagement();
                    } else {
                        var data = await res.json();
                        showAlertModal(data.error || 'Action failed.', 'error');
                    }
                } catch (err) {
                    showAlertModal(err.message || 'Network error.', 'error');
                }
                break;
            }
            case 'waive': {
                var ok = await showConfirm('Waive fee for ' + keyCode + '?', { title: 'Waive Fee' });
                if (!ok) return;
                try {
                    var res = await authenticatedFetch('/api/admin/fines/' + item.fine_id + '/waived', { method: 'POST' });
                    if (res.ok) {
                        showAlertModal('Fee waived.', 'success');
                        closeDetailModal();
                        await loadLostKeys();
                        await loadTransactions();
                        await loadLostKeysManagement();
                    } else {
                        var data = await res.json();
                        showAlertModal(data.error || 'Action failed.', 'error');
                    }
                } catch (err) {
                    showAlertModal(err.message || 'Network error.', 'error');
                }
                break;
            }
            case 'close-ticket': {
                var ok = await showConfirm('Close lost ticket for key ' + keyCode + '?', {
                    title: 'Close Ticket',
                    danger: false,
                    okLabel: 'Close Ticket'
                });
                if (!ok) return;
                var notes = await showPromptModal('Resolution notes (optional):', { title: 'Close Ticket' });
                if (notes === undefined) return;
                try {
                    var res = await authenticatedFetch('/api/admin/lost-keys/' + item.id + '/close', {
                        method: 'POST',
                        body: { resolution_notes: notes || null }
                    });
                    if (res.ok) {
                        showAlertModal('Ticket closed successfully.', 'success');
                        closeDetailModal();
                        await loadLostKeys();
                        await loadTransactions();
                        await loadInventory();
                        await loadLostKeysManagement();
                    } else {
                        var data = await res.json();
                        showAlertModal(data.error || 'Failed to close ticket.', 'error');
                    }
                } catch (err) {
                    showAlertModal(err.message || 'Network error.', 'error');
                }
                break;
            }
            case 'make-available': {
                var ok = await showConfirm('Mark key ' + keyCode + ' as available again?', {
                    title: 'Mark Available',
                    danger: false,
                    okLabel: 'Mark Available'
                });
                if (!ok) return;
                try {
                    var res = await authenticatedFetch('/api/admin/lost-keys/' + item.id + '/make-available', { method: 'POST' });
                    var data = await res.json();
                    if (res.ok) {
                        showAlertModal('Key ' + keyCode + ' is now available.', 'success');
                        closeDetailModal();
                        await loadLostKeys();
                        await loadTransactions();
                        await loadInventory();
                        await loadLostKeysManagement();
                    } else {
                        showAlertModal(data.error || 'Failed to make key available.', 'error');
                    }
                } catch (err) {
                    showAlertModal(err.message || 'Network error.', 'error');
                }
                break;
            }
        }
    }

    async function showLostKeyDetailFromItem(item) {
        var modal = document.getElementById('lostKeyDetailModal');
        var content = document.getElementById('lostKeyDetailContent');
        modal.style.display = 'flex';
        content.innerHTML = '<div class="text-center py-8 text-slate-400">Loading details...</div>';

        try {
            var res = await authenticatedFetch('/api/admin/lost-keys/' + item.id);
            var data = await res.json();
            var statusClass = data.resolved_at ? 'returned' : 'lost';
            var statusLabel = data.resolved_at ? 'Resolved' : 'Lost';

            var html = '<div class="detail-section"><div class="detail-label">Key Information</div>'
                + '<div class="detail-grid"><div><span class="detail-label">Code</span><div class="detail-value">' + escapeHtml(data.key_code) + '</div></div>'
                + '<div><span class="detail-label">Brand</span><div class="detail-value">' + escapeHtml(data.brand || '—') + '</div></div>'
                + '<div><span class="detail-label">Status</span><div class="detail-value"><span class="status-badge ' + statusClass + '">' + statusLabel + '</span></div></div></div></div>'
                + '<div class="detail-section"><div class="detail-label">Borrower</div>'
                + '<div class="detail-grid"><div><span class="detail-label">Name</span><div class="detail-value">' + escapeHtml(data.borrower_name || '—') + '</div></div>'
                + '<div><span class="detail-label">Email</span><div class="detail-value">' + escapeHtml(data.borrower_email || '—') + '</div></div></div></div>'
                + '<div class="detail-section"><div class="detail-label">Lost Event</div>'
                + '<div class="detail-grid"><div><span class="detail-label">Lost At</span><div class="detail-value">' + formatDate(data.lost_at) + '</div></div>'
                + '<div><span class="detail-label">Planned Return</span><div class="detail-value">' + formatDate(data.planned_return) + '</div></div>'
                + (data.returned_at ? '<div><span class="detail-label">Returned At</span><div class="detail-value">' + formatDate(data.returned_at) + '</div></div>' : '')
                + '<div class="full-width"><span class="detail-label">Reason</span><div class="detail-value">' + escapeHtml(data.reason || '—') + '</div></div>'
                + (data.resolved_at ? '<div><span class="detail-label">Resolved At</span><div class="detail-value">' + formatDate(data.resolved_at) + '</div></div>' : '')
                + '</div></div>';

            if (data.fine) {
                var fineStatusClass = data.fine.status === 'paid' ? 'returned' : 'pending';
                html += '<div class="detail-section"><div class="detail-label">Fee</div>'
                    + '<div class="detail-grid"><div><span class="detail-label">Amount</span><div class="detail-value">$' + safeNumber(data.fine.amount).toFixed(2) + '</div></div>'
                    + '<div><span class="detail-label">Status</span><div class="detail-value"><span class="status-badge ' + fineStatusClass + '">' + escapeHtml(data.fine.status || 'pending') + '</span></div></div>'
                    + '<div><span class="detail-label">Issued</span><div class="detail-value">' + formatDate(data.fine.created_at) + '</div></div>'
                    + (data.fine.paid_at ? '<div><span class="detail-label">Paid At</span><div class="detail-value">' + formatDate(data.fine.paid_at) + '</div></div>' : '')
                    + (data.fine.waived_at ? '<div><span class="detail-label">Waived At</span><div class="detail-value">' + formatDate(data.fine.waived_at) + '</div></div>' : '')
                    + '</div></div>';
            }
            content.innerHTML = html;
        } catch (err) {
            content.innerHTML = '<div class="text-center py-8 text-rose-600">Unable to load details: ' + escapeHtml(err.message || 'Please refresh and try again.') + '</div>';
            showAlertModal(err.message || 'Failed to load lost key details.', 'error');
        }
    }

    function showActiveBorrowsModal() {
        var data = window._activeBorrowsData || [];
        if (!data.length) {
            showDetailModal('Active Borrows', '<div class="text-center py-8 text-slate-400">No active borrows.</div>');
            return;
        }
        var rows = '';
        for (var i = 0; i < data.length; i++) {
            var tx = data[i];
            var now = new Date();
            now.setHours(0, 0, 0, 0);
            var due = new Date(tx.planned_return);
            due.setHours(0, 0, 0, 0);
            var statusTag = due < now ? 'Overdue' : due.toDateString() === now.toDateString() ? 'Due today' : 'On loan';
            var statusClass = due < now ? 'overdue' : due.toDateString() === now.toDateString() ? 'pending' : 'borrowed';
            rows += '<tr><td>' + escapeHtml(tx.key_code) + '</td>'
                + '<td>' + escapeHtml(tx.receiver_signature_name || tx.receiver_email) + '</td>'
                + '<td>' + formatDate(tx.borrowed_at) + '</td>'
                + '<td>' + formatDate(tx.planned_return) + '</td>'
                + '<td><span class="status-badge ' + statusClass + '">' + statusTag + '</span></td></tr>';
        }
        showDetailModal('Active Borrows', '<table class="table-clean"><thead><tr><th>Key</th><th>Borrower</th><th>Borrowed</th><th>Expected Return</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table>');
    }

    function showReturnRemindersModal() {
        var data = window._activeBorrowsData || [];
        var today = new Date();
        today.setHours(0, 0, 0, 0);
        var overdue = [];
        var upcoming = [];

        for (var i = 0; i < data.length; i++) {
            var tx = data[i];
            if (!tx.planned_return) continue;
            var d = new Date(tx.planned_return);
            d.setHours(0, 0, 0, 0);
            if (d < today) overdue.push(tx);
            else if (d <= new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)) upcoming.push(tx);
        }

        overdue.sort(function(a, b) { return new Date(a.planned_return) - new Date(b.planned_return); });
        upcoming.sort(function(a, b) { return new Date(a.planned_return) - new Date(b.planned_return); });
        var combined = overdue.concat(upcoming);

        if (!combined.length) {
            showDetailModal('Return Reminders', '<div class="text-center py-8 text-slate-400">No upcoming or overdue returns.</div>');
            return;
        }

        var rows = '';
        var overdueCount = 0;
        for (var j = 0; j < combined.length; j++) {
            var tx = combined[j];
            var due = new Date(tx.planned_return);
            var days = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
            var statusLabel, statusClass;
            if (days < 0) {
                statusLabel = 'Overdue by ' + Math.abs(days) + ' day' + (Math.abs(days) !== 1 ? 's' : '');
                statusClass = 'overdue';
                overdueCount++;
            } else if (days === 0) {
                statusLabel = 'Due today';
                statusClass = 'pending';
            } else {
                statusLabel = days + ' day' + (days !== 1 ? 's' : '') + ' left';
                statusClass = 'borrowed';
            }
            rows += '<tr class="' + (days < 0 ? 'bg-rose-50' : '') + '">'
                + '<td>' + escapeHtml(tx.key_code) + '</td>'
                + '<td>' + escapeHtml(tx.receiver_signature_name || tx.receiver_email) + '</td>'
                + '<td>' + formatDate(tx.planned_return) + '</td>'
                + '<td><span class="status-badge ' + statusClass + '">' + statusLabel + '</span></td></tr>';
        }

        var summary = overdueCount > 0 ? '<div class="mb-3 p-2 bg-rose-100 text-rose-800 rounded-lg text-sm font-medium">⚠️ ' + overdueCount + ' overdue return' + (overdueCount > 1 ? 's' : '') + ' — please take action.</div>' : '';
        showDetailModal('Return Reminders', summary + '<table class="table-clean"><thead><tr><th>Key</th><th>Borrower</th><th>Due Date</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table>');
    }

    // ==================== INVENTORY ====================
    async function loadInventory() {
        var container = document.getElementById('inventoryTableBody');
        container.innerHTML = '<tr><td colspan="7" class="text-center py-8 text-slate-400"><div class="skeleton h-8 w-full"></div></td></tr>';

        try {
            var res = await authenticatedFetch('/api/admin/keys');
            var data = await res.json();
            inventoryData = Array.isArray(data) ? data : [];
            applyInventoryFilters();
        } catch (err) {
            container.innerHTML = '<tr><td colspan="7" class="text-center py-8 text-rose-600">Unable to load keys. Please refresh the page.</td></tr>';
            showAlertModal(err.message || 'Failed to load inventory.', 'error');
        }
    }

    function applyInventoryFilters() {
        var search = safeLower(document.getElementById('inventorySearchInput').value).trim();
        filteredInventory = inventoryData.filter(function(key) {
            return safeLower(key.code).indexOf(search) !== -1 ||
                safeLower(key.brand).indexOf(search) !== -1 ||
                safeLower(key.sets).indexOf(search) !== -1 ||
                safeLower(key.remarks).indexOf(search) !== -1;
        });
        invTotal = filteredInventory.length;
        renderInventoryTable();
        updateInventoryPagination();
    }

    function renderInventoryTable() {
        var tbody = document.getElementById('inventoryTableBody');
        var start = (invPage - 1) * invRows;
        var end = Math.min(start + invRows, invTotal);
        var pageData = filteredInventory.slice(start, end);

        if (!pageData.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center py-8 text-slate-400">No keys found.</td></tr>';
            return;
        }

        var html = '';
        for (var i = 0; i < pageData.length; i++) {
            var key = pageData[i];
            var setsDisplay = '—';
            if (key.sets && Array.isArray(key.sets) && key.sets.length) {
                setsDisplay = key.sets.map(function(s) { return escapeHtml(s.owner_name || 'Unknown') + ' (' + (s.quantity || 1) + ')'; }).join(', ');
            }
            var status = key.status || 'unknown';

            html += '<tr class="inventory-row" data-key-id="' + key.id + '">'
                + '<td class="clickable-cell"><code>' + escapeHtml(key.code) + '</code></td>'
                + '<td class="clickable-cell">' + escapeHtml(key.brand) + '</td>'
                + '<td>' + statusBadgeHtml(status) + '</td>'
                + '<td class="clickable-cell">' + escapeHtml(setsDisplay) + '</td>'
                + '<td class="clickable-cell">' + escapeHtml(key.total_quantity || 0) + '</td>'
                + '<td class="clickable-cell">' + escapeHtml(key.remarks || '—') + '</td>'
                + '<td><button class="btn btn-sm btn-ghost inventory-actions-btn" data-key-id="' + key.id + '"><i class="fas fa-ellipsis-v"></i></button></td></tr>';
        }
        tbody.innerHTML = html;

        tbody.querySelectorAll('.clickable-cell').forEach(function(cell) {
            cell.style.cursor = 'pointer';
            cell.addEventListener('click', function() {
                var row = this.closest('tr');
                if (row) {
                    showKeyDetailModal(parseInt(row.dataset.keyId));
                }
            });
        });

        tbody.querySelectorAll('.inventory-actions-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var key = null;
                for (var k = 0; k < inventoryData.length; k++) {
                    if (inventoryData[k].id === parseInt(this.dataset.keyId)) {
                        key = inventoryData[k];
                        break;
                    }
                }
                if (!key) return;

                var menuHtml = '';
                if (key.status !== 'available' && key.status !== 'borrowed') {
                    menuHtml += '<button class="menu-item" data-action="available"><i class="fas fa-check-circle"></i> Mark Available</button>';
                }
                if (key.status === 'available') {
                    menuHtml += '<button class="menu-item" data-action="unavailable"><i class="fas fa-ban"></i> Mark Unavailable</button>';
                }
                if (key.status === 'borrowed') {
                    menuHtml += '<button class="menu-item disabled" disabled>Currently borrowed</button>';
                }
                menuHtml += '<div class="menu-divider"></div>'
                    + '<button class="menu-item" data-action="view"><i class="fas fa-eye"></i> View Details</button>'
                    + '<button class="menu-item" data-action="edit"><i class="fas fa-edit"></i> Edit Key</button>';

                openPortalMenu(this, menuHtml, function(menu) {
                    menu.querySelectorAll('.menu-item[data-action]').forEach(function(item) {
                        item.addEventListener('click', async function() {
                            var action = this.dataset.action;
                            menu.remove();

                            if (action === 'view') {
                                showKeyDetailModal(key.id);
                                return;
                            }
                            if (action === 'edit') {
                                openKeyEditModal(key);
                                return;
                            }

                            var endpoint = action === 'available' ? 'available' : 'unavailable';
                            try {
                                var res = await authenticatedFetch('/api/admin/keys/' + key.id + '/' + endpoint, { method: 'POST' });
                                var data = await res.json();
                                if (res.ok) {
                                    showAlertModal('Key marked ' + endpoint + '.', 'success');
                                    loadInventory();
                                } else {
                                    showAlertModal(data.error || 'Update failed.', 'error');
                                }
                            } catch (err) {
                                showAlertModal(err.message || 'Network error.', 'error');
                            }
                        });
                    });
                });
            });
        });
    }

    function updateInventoryPagination() {
        var totalPages = Math.ceil(invTotal / invRows) || 1;
        var start = (invPage - 1) * invRows + 1;
        var end = Math.min(invPage * invRows, invTotal);
        document.getElementById('inventoryPaginationInfo').innerText = invTotal === 0 ?
            'Showing 0 of 0 keys' :
            'Showing ' + start + '–' + end + ' of ' + invTotal + ' keys';
        document.getElementById('inventoryPrevPageBtn').disabled = invPage === 1 || invTotal === 0;
        document.getElementById('inventoryNextPageBtn').disabled = invPage >= totalPages || invTotal === 0;
    }

    async function showKeyDetailModal(keyId) {
        var modal = document.getElementById('keyDetailModal');
        var content = document.getElementById('keyDetailModalContent');
        modal.style.display = 'flex';
        content.innerHTML = '<div class="text-center py-8 text-slate-400">Loading key details...</div>';

        try {
            var results = await Promise.all([
                authenticatedFetch('/api/admin/keys/' + keyId),
                authenticatedFetch('/api/audit/logs?target_type=key&target_id=' + keyId)
            ]);
            var key = await results[0].json();
            var auditLogs = await results[1].json();

            var setsDisplay = '—';
            if (key.sets && Array.isArray(key.sets) && key.sets.length) {
                setsDisplay = key.sets.map(function(s) { return escapeHtml(s.owner_name) + ' (' + s.quantity + ')'; }).join(', ');
            }

            var auditHtml = '<div class="detail-section"><div class="detail-label">Audit Trail</div>';
            if (auditLogs && auditLogs.length) {
                auditHtml += '<table class="table-clean"><thead><tr><th>Action</th><th>User</th><th>Timestamp</th></tr></thead><tbody>';
                var maxLogs = Math.min(auditLogs.length, 10);
                for (var l = 0; l < maxLogs; l++) {
                    var log = auditLogs[l];
                    auditHtml += '<tr><td>' + escapeHtml(log.action) + '</td>'
                        + '<td>' + escapeHtml(log.user_name || log.user_email || 'System') + '</td>'
                        + '<td>' + formatDate(log.created_at) + '</td></tr>';
                }
                auditHtml += '</tbody></table>';
                if (auditLogs.length > 10) {
                    auditHtml += '<p class="text-xs text-slate-500 mt-2">Showing last 10 of ' + auditLogs.length + ' entries</p>';
                }
            } else {
                auditHtml += '<p class="text-sm text-slate-500">No audit logs found for this key.</p>';
            }
            auditHtml += '</div>';

            var html = '<div class="detail-section"><div class="detail-label">Key Information</div>'
                + '<div class="detail-grid"><div><span class="detail-label">Code</span><div class="detail-value">' + escapeHtml(key.code) + '</div></div>'
                + '<div><span class="detail-label">Brand</span><div class="detail-value">' + escapeHtml(key.brand) + '</div></div>'
                + '<div><span class="detail-label">Status</span><div class="detail-value">' + statusBadgeHtml(key.status || 'unknown') + '</div></div>'
                + '<div><span class="detail-label">Owner(s)</span><div class="detail-value">' + escapeHtml(setsDisplay) + '</div></div>'
                + '<div><span class="detail-label">Total Quantity</span><div class="detail-value">' + escapeHtml(key.total_quantity || 0) + '</div></div>'
                + '<div class="full-width"><span class="detail-label">Remarks</span><div class="detail-value">' + escapeHtml(key.remarks || '—') + '</div></div></div></div>'
                + '<div class="detail-section"><div class="detail-label">Key Metadata</div>'
                + '<div class="detail-grid"><div><span class="detail-label">Created At</span><div class="detail-value">' + formatDate(key.created_at) + '</div></div>'
                + '<div><span class="detail-label">Last Updated</span><div class="detail-value">' + formatDate(key.updated_at) + '</div></div>'
                + '<div><span class="detail-label">Updated By</span><div class="detail-value">' + escapeHtml(key.updated_by || '—') + '</div></div></div></div>'
                + auditHtml;

            content.innerHTML = html;
            document.getElementById('keyDetailModalTitle').textContent = 'Key: ' + key.code;
        } catch (err) {
            content.innerHTML = '<div class="text-center py-8 text-rose-600">Unable to load key details: ' + escapeHtml(err.message || 'Please refresh and try again.') + '</div>';
            showAlertModal(err.message || 'Failed to load key details.', 'error');
        }
    }

    // ==================== KEY MANAGEMENT ====================
    async function openKeyManageModal() {
        document.getElementById('keyManageModal').style.display = 'flex';
        await fetchManageKeys();
    }

    async function fetchManageKeys() {
        var tbody = document.getElementById('manageKeyTableBody');
        tbody.innerHTML = '<tr><td colspan="5" class="text-center py-8 text-slate-400">Loading keys...</td></tr>';
        var search = safeLower(document.getElementById('manageKeySearch') ? document.getElementById('manageKeySearch').value : '').trim();

        try {
            var res = await authenticatedFetch('/api/admin/keys');
            var data = await res.json();
            manageKeyData = Array.isArray(data) ? data : [];
            manageKeyFiltered = manageKeyData.filter(function(key) {
                return safeLower(key.code).indexOf(search) !== -1 ||
                    safeLower(key.brand).indexOf(search) !== -1 ||
                    safeLower(key.sets).indexOf(search) !== -1;
            });
            manageKeyTotal = manageKeyFiltered.length;
            renderManageKeyTable();
            updateManageKeyPagination();
        } catch (err) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center py-8 text-rose-600">Unable to load keys.</td></tr>';
            showAlertModal(err.message || 'Failed to load keys for management.', 'error');
        }
    }

    function renderManageKeyTable() {
        var tbody = document.getElementById('manageKeyTableBody');
        var start = (manageKeyPage - 1) * manageKeyRows;
        var end = Math.min(start + manageKeyRows, manageKeyTotal);
        var pageData = manageKeyFiltered.slice(start, end);

        if (!pageData.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center py-8 text-slate-400">No keys found.</td></tr>';
            return;
        }

        var html = '';
        for (var i = 0; i < pageData.length; i++) {
            var key = pageData[i];
            var setsDisplay = '—';
            if (key.sets && Array.isArray(key.sets) && key.sets.length) {
                setsDisplay = key.sets.map(function(s) { return escapeHtml(s.owner_name) + ' (' + s.quantity + ')'; }).join(', ');
            }
            var status = key.status || 'unknown';

            html += '<tr><td class="text-left"><code>' + escapeHtml(key.code) + '</code></td>'
                + '<td class="text-left">' + escapeHtml(key.brand) + '</td>'
                + '<td class="text-left">' + statusBadgeHtml(status) + '</td>'
                + '<td class="text-left">' + escapeHtml(setsDisplay) + '</td>'
                + '<td class="text-right"><div class="action-buttons" style="justify-content:flex-end;">'
                + '<button class="btn btn-secondary btn-sm edit-manage-key-btn" data-id="' + key.id + '"><i class="fas fa-edit"></i> Edit</button>'
                + '<button class="btn btn-danger btn-sm delete-manage-key-btn" data-id="' + key.id + '" data-code="' + escapeHtml(key.code) + '"><i class="fas fa-trash"></i> Delete</button>'
                + '</div></td></tr>';
        }
        tbody.innerHTML = html;

        tbody.querySelectorAll('.edit-manage-key-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var id = parseInt(this.dataset.id);
                var key = null;
                for (var k = 0; k < manageKeyData.length; k++) {
                    if (manageKeyData[k].id === id) {
                        key = manageKeyData[k];
                        break;
                    }
                }
                if (key) {
                    openKeyEditModal(key);
                    document.getElementById('keyManageModal').style.display = 'none';
                }
            });
        });

        tbody.querySelectorAll('.delete-manage-key-btn').forEach(function(btn) {
            btn.addEventListener('click', async function() {
                var id = this.dataset.id;
                var code = this.dataset.code;

                var ok = await showConfirm(
                    'Delete key ' + code + '? This action will soft-delete the key (set status to inactive). The key record will be preserved for audit purposes.',
                    { title: 'Delete Key' }
                );
                if (!ok) return;

                try {
                    var res = await authenticatedFetch('/api/admin/keys/' + id, { method: 'DELETE' });

                    if (res.ok) {
                        var data = await res.json();
                        showAlertModal('Key ' + code + ' has been deactivated successfully. The record is preserved for audit purposes.', 'success');
                        fetchManageKeys();
                        loadInventory();
                    } else {
                        var data = await res.json();
                        showAlertModal(data.error || 'Deletion failed.', 'error');
                    }
                } catch (err) {
                    showAlertModal(err.message || 'Network error.', 'error');
                }
            });
        });
    }

    function updateManageKeyPagination() {
        var totalPages = Math.ceil(manageKeyTotal / manageKeyRows) || 1;
        var start = (manageKeyPage - 1) * manageKeyRows + 1;
        var end = Math.min(manageKeyPage * manageKeyRows, manageKeyTotal);
        document.getElementById('manageKeyPaginationInfo').innerText = manageKeyTotal === 0 ?
            'Showing 0 of 0 keys' :
            'Showing ' + start + '–' + end + ' of ' + manageKeyTotal + ' keys';
        document.getElementById('manageKeyPrevBtn').disabled = manageKeyPage === 1 || manageKeyTotal === 0;
        document.getElementById('manageKeyNextBtn').disabled = manageKeyPage >= totalPages || manageKeyTotal === 0;
    }

    function openKeyEditModal(key) {
        key = key || null;
        var modal = document.getElementById('keyEditModal');
        var title = document.getElementById('keyEditModalTitle');
        var idField = document.getElementById('editKeyId');
        var codeField = document.getElementById('editKeyCode');
        var brandField = document.getElementById('editKeyBrand');
        var ownerField = document.getElementById('editKeyOwner');
        var setsField = document.getElementById('editKeySets');
        var dateOwnedField = document.getElementById('editKeyDateOwned');
        var remarksField = document.getElementById('editKeyRemarks');
        var statusField = document.getElementById('editKeyStatus');

        if (key) {
            title.textContent = 'Edit Key';
            idField.value = key.id;
            codeField.value = key.code;
            brandField.value = key.brand;
            if (key.sets && Array.isArray(key.sets) && key.sets.length) {
                ownerField.value = key.sets.map(function(s) { return s.owner_name; }).join(', ');
                setsField.value = key.sets.reduce(function(sum, s) { return sum + (s.quantity || 0); }, 0);
            } else {
                ownerField.value = '';
                setsField.value = '';
            }
            dateOwnedField.value = key.date_owned || '';
            remarksField.value = key.remarks || '';
            statusField.value = key.status || 'available';
        } else {
            title.textContent = 'Add New Key';
            idField.value = '';
            codeField.value = '';
            brandField.value = '';
            ownerField.value = '';
            setsField.value = '';
            dateOwnedField.value = '';
            remarksField.value = '';
            statusField.value = 'available';
        }
        modal.style.display = 'flex';
    }

    // ==================== LOST KEYS MANAGEMENT ====================
    async function loadLostKeysManagement() {
        var container = document.getElementById('lostKeysManagementContainer');
        if (!container) return;
        container.innerHTML = '<div class="text-center py-8 text-slate-400">Loading lost keys...</div>';

        try {
            var res = await authenticatedFetch('/api/admin/lost-keys');
            var data = await res.json();

            if (!data.length) {
                container.innerHTML = '<div class="text-center py-8 text-slate-400">No lost keys found.</div>';
                return;
            }

            var html = '<table class="table-clean"><thead><tr>'
                + '<th class="text-left">Key Code</th><th class="text-left">Brand</th>'
                + '<th class="text-left">Borrower</th><th style="text-align:center;">Lost Date</th>'
                + '<th style="text-align:center;">Status</th><th style="text-align:right;">Actions</th>'
                + '</tr></thead><tbody>';

            for (var i = 0; i < data.length; i++) {
                var item = data[i];
                var statusClass = item.resolved_at ? 'returned' : 'lost';
                var statusLabel = item.resolved_at ? 'Resolved' : 'Lost';

                html += '<tr><td class="text-left"><code>' + escapeHtml(item.key_code) + '</code></td>'
                    + '<td class="text-left">' + escapeHtml(item.brand) + '</td>'
                    + '<td class="text-left">' + escapeHtml(item.borrower_name || item.borrower_email) + '</td>'
                    + '<td style="text-align:center;">' + formatDate(item.lost_at) + '</td>'
                    + '<td style="text-align:center;"><span class="status-badge ' + statusClass + '">' + statusLabel + '</span></td>'
                    + '<td style="text-align:right;"><button class="btn btn-sm btn-ghost lost-key-actions-btn" data-id="' + item.id + '"><i class="fas fa-ellipsis-v"></i></button></td></tr>';
            }
            html += '</tbody></table>';
            container.innerHTML = html;

            container.querySelectorAll('.lost-key-actions-btn').forEach(function(btn) {
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    var id = parseInt(this.dataset.id);
                    var lostItem = null;
                    for (var d = 0; d < data.length; d++) {
                        if (data[d].id === id) {
                            lostItem = data[d];
                            break;
                        }
                    }
                    if (!lostItem) return;

                    var menuHtml = '<button class="menu-item" data-action="view"><i class="fas fa-eye"></i> View</button>'
                        + '<button class="menu-item" data-action="edit"><i class="fas fa-edit"></i> Edit</button>'
                        + '<div class="menu-divider"></div>';

                    if (!lostItem.resolved_at) {
                        menuHtml += '<button class="menu-item" data-action="close-ticket"><i class="fas fa-check-circle"></i> Close Ticket</button>';
                    }
                    menuHtml += '<button class="menu-item" data-action="make-available"><i class="fas fa-check"></i> Make Available</button>';

                    openPortalMenu(this, menuHtml, function(menu) {
                        menu.querySelectorAll('.menu-item[data-action]').forEach(function(item) {
                            item.addEventListener('click', function() {
                                var action = this.dataset.action;
                                menu.remove();

                                if (action === 'view') {
                                    showLostKeyDetail(id);
                                } else if (action === 'edit') {
                                    openLostKeyEditModal(id);
                                } else if (action === 'close-ticket') {
                                    handleCloseTicket(id, lostItem.key_code);
                                } else if (action === 'make-available') {
                                    handleMakeAvailable(id, lostItem.key_code);
                                }
                            });
                        });
                    });
                });
            });
        } catch (err) {
            container.innerHTML = '<div class="text-center py-8 text-rose-600">Failed to load lost keys: ' + escapeHtml(err.message) + '</div>';
            showAlertModal(err.message || 'Failed to load lost keys.', 'error');
        }
    }

    async function handleCloseTicket(id, key) {
        var ok = await showConfirm('Close lost ticket for key ' + key + '?', {
            title: 'Close Ticket',
            danger: false,
            okLabel: 'Close Ticket'
        });
        if (!ok) return;

        var notes = await showPromptModal('Resolution notes (optional):', { title: 'Close Ticket' });
        if (notes === undefined) return;

        try {
            var res = await authenticatedFetch('/api/admin/lost-keys/' + id + '/close', {
                method: 'POST',
                body: { resolution_notes: notes || null }
            });
            var data = await res.json();

            if (res.ok) {
                showAlertModal('Ticket closed successfully.', 'success');
                closeDetailModal();
                loadLostKeysManagement();
                loadLostKeys();
                loadInventory();
            } else {
                showAlertModal(data.error || 'Failed to close ticket.', 'error');
            }
        } catch (err) {
            showAlertModal(err.message || 'Network error.', 'error');
        }
    }

    async function handleMakeAvailable(id, key) {
        var ok = await showConfirm('Mark key ' + key + ' as available again?', {
            title: 'Mark Available',
            danger: false,
            okLabel: 'Mark Available'
        });
        if (!ok) return;

        try {
            var res = await authenticatedFetch('/api/admin/lost-keys/' + id + '/make-available', { method: 'POST' });
            var data = await res.json();

            if (res.ok) {
                showAlertModal('Key ' + key + ' is now available.', 'success');
                closeDetailModal();
                loadLostKeysManagement();
                loadLostKeys();
                loadInventory();
            } else {
                showAlertModal(data.error || 'Failed to make key available.', 'error');
            }
        } catch (err) {
            showAlertModal(err.message || 'Network error.', 'error');
        }
    }

    async function showLostKeyDetail(id) {
        var modal = document.getElementById('lostKeyDetailModal');
        var content = document.getElementById('lostKeyDetailContent');
        modal.style.display = 'flex';
        content.innerHTML = '<div class="text-center py-8 text-slate-400">Loading...</div>';

        try {
            var res = await authenticatedFetch('/api/admin/lost-keys/' + id);
            var data = await res.json();
            var statusClass = data.resolved_at ? 'returned' : 'lost';
            var statusLabel = data.resolved_at ? 'Resolved' : 'Lost';

            var html = '<div class="detail-section"><div class="detail-label">Key Information</div>'
                + '<div class="detail-grid"><div><span class="detail-label">Code</span><div class="detail-value">' + escapeHtml(data.key_code) + '</div></div>'
                + '<div><span class="detail-label">Brand</span><div class="detail-value">' + escapeHtml(data.brand) + '</div></div>'
                + '<div><span class="detail-label">Status</span><div class="detail-value"><span class="status-badge ' + statusClass + '">' + statusLabel + '</span></div></div></div></div>'
                + '<div class="detail-section"><div class="detail-label">Borrower</div>'
                + '<div class="detail-grid"><div><span class="detail-label">Name</span><div class="detail-value">' + escapeHtml(data.borrower_name || '—') + '</div></div>'
                + '<div><span class="detail-label">Email</span><div class="detail-value">' + escapeHtml(data.borrower_email || '—') + '</div></div></div></div>'
                + '<div class="detail-section"><div class="detail-label">Lost Event</div>'
                + '<div class="detail-grid"><div><span class="detail-label">Lost At</span><div class="detail-value">' + formatDate(data.lost_at) + '</div></div>'
                + '<div><span class="detail-label">Planned Return</span><div class="detail-value">' + formatDate(data.planned_return) + '</div></div>'
                + (data.returned_at ? '<div><span class="detail-label">Returned At</span><div class="detail-value">' + formatDate(data.returned_at) + '</div></div>' : '')
                + '<div class="full-width"><span class="detail-label">Reason for Loss</span><div class="detail-value">' + escapeHtml(data.reason || '—') + '</div></div>'
                + (data.resolved_at ? '<div><span class="detail-label">Resolved At</span><div class="detail-value">' + formatDate(data.resolved_at) + '</div></div>' : '')
                + '</div></div>';

            if (data.fine) {
                var fineStatusClass = data.fine.status === 'paid' ? 'returned' : 'pending';
                html += '<div class="detail-section"><div class="detail-label">Fee</div>'
                    + '<div class="detail-grid"><div><span class="detail-label">Amount</span><div class="detail-value">$' + safeNumber(data.fine.amount).toFixed(2) + '</div></div>'
                    + '<div><span class="detail-label">Status</span><div class="detail-value"><span class="status-badge ' + fineStatusClass + '">' + escapeHtml(data.fine.status || 'pending') + '</span></div></div>'
                    + '<div><span class="detail-label">Issued</span><div class="detail-value">' + formatDate(data.fine.created_at) + '</div></div>'
                    + (data.fine.paid_at ? '<div><span class="detail-label">Paid At</span><div class="detail-value">' + formatDate(data.fine.paid_at) + '</div></div>' : '')
                    + (data.fine.waived_at ? '<div><span class="detail-label">Waived At</span><div class="detail-value">' + formatDate(data.fine.waived_at) + '</div></div>' : '')
                    + '</div></div>';
            }
            content.innerHTML = html;
            document.getElementById('lostKeyDetailTitle').textContent = 'Lost Key: ' + data.key_code;
        } catch (err) {
            content.innerHTML = '<div class="text-center py-8 text-rose-600">Unable to load details: ' + escapeHtml(err.message || 'Please refresh and try again.') + '</div>';
            showAlertModal(err.message || 'Failed to load lost key details.', 'error');
        }
    }

    async function openLostKeyEditModal(id) {
        var modal = document.getElementById('lostKeyEditModal');
        modal.style.display = 'flex';

        try {
            var res = await authenticatedFetch('/api/admin/lost-keys/' + id);
            var data = await res.json();

            document.getElementById('editLostTransactionId').value = id;
            document.getElementById('editLostKeyCode').value = data.key_code || '';
            document.getElementById('editLostBrand').value = data.brand || '';
            document.getElementById('editLostBorrower').value = data.borrower_name || data.borrower_email || '';
            document.getElementById('editLostReason').value = data.reason || '';

            if (data.lost_at) {
                var date = new Date(data.lost_at);
                document.getElementById('editLostDate').value = date.toISOString().slice(0, 16);
            }

            document.getElementById('editLostStatus').value = data.resolved_at ? 'resolved' : 'lost';
            document.getElementById('lostKeyEditTitle').textContent = 'Edit Lost Key: ' + data.key_code;
        } catch (err) {
            showAlertModal(err.message || 'Failed to load lost key details.', 'error');
            modal.style.display = 'none';
        }
    }

    // ==================== EMAIL ====================
    async function checkEmailPermissions() {
        try {
            var res = await authenticatedFetch('/api/user/permissions');
            var data = await res.json();
            var permsArray = Array.isArray(data) ? data : [];
            var canManageTemplates = false;
            var canManageSettings = false;
            for (var i = 0; i < permsArray.length; i++) {
                if (permsArray[i] === 'manage_email_templates') canManageTemplates = true;
                if (permsArray[i] === 'manage_notification_settings') canManageSettings = true;
            }
            var canManageEmail = canManageTemplates && canManageSettings;
            var emailTab = document.querySelector('.tab-button[data-tab="email"]');
            if (emailTab) emailTab.style.display = canManageEmail ? '' : 'none';
            return canManageEmail;
        } catch (err) {
            var emailTab = document.querySelector('.tab-button[data-tab="email"]');
            if (emailTab) emailTab.style.display = 'none';
            showAlertModal(err.message || 'Unable to load permissions.', 'error');
            return false;
        }
    }

    async function loadEmailTab() {
        if (emailTabLoaded) return;
        var canManage = await checkEmailPermissions();
        if (!canManage) return;
        emailTabLoaded = true;
        await Promise.all([loadTemplates(), loadSettings()]);
        loadAdminRecipients();
    }

    async function loadTemplates() {
        var container = document.getElementById('templatesContainer');
        container.innerHTML = '<div class="text-center py-8 text-slate-400">Loading templates...</div>';

        try {
            var res = await authenticatedFetch('/api/admin/email/templates');
            var templates = await res.json();

            if (!templates.length) {
                container.innerHTML = '<div class="text-center py-8 text-slate-400">No templates found.</div>';
                return;
            }

            var html = '<table class="table-clean template-list"><thead><tr>'
                + '<th class="text-left">Key</th><th class="text-left">Subject</th>'
                + '<th style="text-align:center;">Active</th><th style="text-align:right;">Actions</th>'
                + '</tr></thead><tbody>';

            for (var i = 0; i < templates.length; i++) {
                var t = templates[i];
                html += '<tr class="template-row" data-key="' + escapeHtml(t.template_key) + '">'
                    + '<td class="text-left"><code>' + escapeHtml(t.template_key) + '</code></td>'
                    + '<td class="text-left">' + escapeHtml(t.subject) + '</td>'
                    + '<td style="text-align:center;">' + (t.is_active ? '✅' : '❌') + '</td>'
                    + '<td style="text-align:right;"><div class="action-buttons" style="justify-content:flex-end;">'
                    + '<button class="btn btn-secondary btn-sm preview-template-btn" data-key="' + escapeHtml(t.template_key) + '" title="Preview Template"><i class="fas fa-eye"></i> Preview</button>'
                    + '<button class="btn btn-secondary btn-sm edit-template-btn" data-key="' + escapeHtml(t.template_key) + '" title="Edit Template"><i class="fas fa-edit"></i> Edit</button>'
                    + '</div></td></tr>';
            }
            html += '</tbody></table>';
            container.innerHTML = html;

            container.querySelectorAll('.preview-template-btn').forEach(function(btn) {
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    previewTemplate(this.dataset.key);
                });
            });

            container.querySelectorAll('.edit-template-btn').forEach(function(btn) {
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    openTemplateEditModal(this.dataset.key);
                });
            });

            container.querySelectorAll('.template-row').forEach(function(row) {
                row.addEventListener('click', function(e) {
                    if (!e.target.closest('.action-buttons')) {
                        openTemplateEditModal(this.dataset.key);
                    }
                });
                row.style.cursor = 'pointer';
            });
        } catch (err) {
            container.innerHTML = '<div class="text-center py-8 text-rose-600">Failed to load templates. Please refresh.</div>';
            showAlertModal(err.message || 'Unable to load email templates.', 'error');
        }
    }

    async function previewTemplate(templateKey) {
        try {
            var res = await authenticatedFetch('/api/admin/email/templates/' + templateKey);
            var template = await res.json();

            var existingModal = document.getElementById('templatePreviewModal');
            if (existingModal) existingModal.remove();

            var modal = document.createElement('div');
            modal.className = 'modal-overlay active';
            modal.id = 'templatePreviewModal';
            modal.style.display = 'flex';
            modal.style.zIndex = '100001';

            modal.innerHTML = '<div class="modal-container" style="max-width:800px;max-height:90vh;">'
                + '<div class="modal-header"><h3><i class="fas fa-eye"></i> Template Preview: ' + escapeHtml(template.template_key) + '</h3>'
                + '<button class="close-btn" id="templatePreviewCloseBtn">&times;</button></div>'
                + '<div class="modal-body" style="padding:0;overflow:hidden;">'
                + '<div style="padding:1rem 1.5rem;background:#f8fafc;border-bottom:1px solid #e2e8f0;">'
                + '<p style="margin:0;font-size:0.85rem;color:#64748b;"><strong>Subject:</strong> ' + escapeHtml(template.subject) + '</p>'
                + '<p style="margin:0.25rem 0 0;font-size:0.8rem;color:#64748b;"><strong>Status:</strong> ' + (template.is_active ? '✅ Active' : '❌ Inactive') + '</p>'
                + '</div><div style="padding:1.5rem;max-height:60vh;overflow-y:auto;background:#f4f7fc;">' + template.body_html + '</div>'
                + '</div><div class="modal-footer" style="gap:8px;justify-content:flex-end;">'
                + '<button class="btn btn-refresh" id="templatePreviewCloseFooterBtn">Close</button>'
                + '<button class="btn btn-primary" id="templatePreviewOkBtn">OK</button>'
                + '</div></div>';

            document.body.appendChild(modal);

            var closeModal = function() {
                var modalEl = document.getElementById('templatePreviewModal');
                if (modalEl) modalEl.remove();
            };

            modal.addEventListener('click', function(e) {
                if (e.target === this) closeModal();
            });

            document.getElementById('templatePreviewCloseBtn') && document.getElementById('templatePreviewCloseBtn').addEventListener('click', closeModal);
            document.getElementById('templatePreviewCloseFooterBtn') && document.getElementById('templatePreviewCloseFooterBtn').addEventListener('click', closeModal);
            document.getElementById('templatePreviewOkBtn') && document.getElementById('templatePreviewOkBtn').addEventListener('click', closeModal);

            var escHandler = function(e) {
                if (e.key === 'Escape') {
                    closeModal();
                    document.removeEventListener('keydown', escHandler);
                }
            };
            document.addEventListener('keydown', escHandler);
        } catch (err) {
            showAlertModal('Failed to preview template: ' + err.message, 'error');
        }
    }

    async function openTemplateManageModal() {
        var modal = document.getElementById('templateManageModal');
        var container = document.getElementById('templateManageContainer');
        modal.style.display = 'flex';
        container.innerHTML = '<div class="text-center py-8 text-slate-400">Loading templates...</div>';

        try {
            var res = await authenticatedFetch('/api/admin/email/templates');
            var templates = await res.json();

            if (!templates.length) {
                container.innerHTML = '<div class="text-center py-8 text-slate-400">No templates found.</div>';
                return;
            }

            var html = '<table class="table-clean template-manage-table"><thead><tr>'
                + '<th class="text-left">Key</th><th class="text-left">Subject</th><th>Active</th>'
                + '<th class="text-right">Actions</th></tr></thead><tbody>';

            for (var i = 0; i < templates.length; i++) {
                var t = templates[i];
                html += '<tr><td class="text-left"><code>' + escapeHtml(t.template_key) + '</code></td>'
                    + '<td class="text-left">' + escapeHtml(t.subject) + '</td>'
                    + '<td>' + (t.is_active ? '✅' : '❌') + '</td>'
                    + '<td class="text-right"><div class="action-buttons" style="justify-content:flex-end;">'
                    + '<button class="btn btn-secondary btn-sm edit" data-key="' + escapeHtml(t.template_key) + '" title="Edit"><i class="fas fa-edit"></i> Edit</button>'
                    + '<button class="btn btn-danger btn-sm delete" data-key="' + escapeHtml(t.template_key) + '" title="Delete"><i class="fas fa-trash"></i> Delete</button>'
                    + '</div></td></tr>';
            }
            html += '</tbody></table>';
            container.innerHTML = html;

            container.querySelectorAll('.edit').forEach(function(btn) {
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    openTemplateEditModal(this.dataset.key);
                });
            });

            container.querySelectorAll('.delete').forEach(function(btn) {
                btn.addEventListener('click', async function(e) {
                    e.stopPropagation();
                    var key = this.dataset.key;
                    var ok = await showConfirm('Delete template "' + key + '"?', { title: 'Delete Template' });
                    if (!ok) return;

                    try {
                        var res = await authenticatedFetch('/api/admin/email/templates/' + key, { method: 'DELETE' });
                        if (res.ok) {
                            showAlertModal('Template deleted successfully.', 'success');
                            openTemplateManageModal();
                            loadTemplates();
                        } else {
                            var data = await res.json();
                            showAlertModal(data.error || 'Delete failed.', 'error');
                        }
                    } catch (err) {
                        showAlertModal(err.message || 'Network error.', 'error');
                    }
                });
            });
        } catch (err) {
            container.innerHTML = '<div class="text-center py-8 text-rose-600">Failed to load templates. Please refresh.</div>';
            showAlertModal(err.message || 'Unable to load templates.', 'error');
        }
    }

    async function openTemplateEditModal(key) {
        try {
            var res = await authenticatedFetch('/api/admin/email/templates/' + key);
            var template = await res.json();

            document.getElementById('editTemplateKey').value = key;
            document.getElementById('editTemplateKeyDisplay').value = key;
            document.getElementById('editTemplateKeyDisplay').disabled = true;
            document.getElementById('editTemplateSubject').value = template.subject || '';
            document.getElementById('editTemplateBody').value = template.body_html || '';
            document.getElementById('editTemplateActive').checked = template.is_active !== false;
            document.getElementById('templateEditModalTitle').textContent = 'Edit Template: ' + key;
            document.getElementById('templateEditModal').style.display = 'flex';
        } catch (err) {
            showAlertModal(err.message || 'Failed to load template details.', 'error');
        }
    }

    async function loadSettings() {
        var container = document.getElementById('settingsContainer');
        container.innerHTML = '<div class="text-center py-8 text-slate-400">Loading settings...</div>';

        try {
            var res = await authenticatedFetch('/api/admin/email/settings');
            var settings = await res.json();

            if (!settings.length) {
                container.innerHTML = '<div class="text-center py-8 text-slate-400">No settings found.</div>';
                return;
            }

            var categories = {
                user: { label: 'User Notifications', keys: ['send_otp', 'send_welcome_email', 'send_password_reset', 'send_account_locked'] },
                requests: { label: 'Request Notifications', keys: ['send_request_submitted', 'send_request_approved'] },
                admin: { label: 'Admin Alerts', keys: ['send_admin_new_registration', 'send_admin_new_key_request'] },
                reminders: { label: 'Reminders', keys: ['send_reminders'] },
                fines: { label: 'Fine Notifications', keys: ['send_fine_created', 'send_fine_paid'] }
            };

            var html = '';
            for (var catKey in categories) {
                if (categories.hasOwnProperty(catKey)) {
                    var cat = categories[catKey];
                    html += '<div class="setting-category">' + cat.label + '</div>';
                    for (var s = 0; s < cat.keys.length; s++) {
                        var settingKey = cat.keys[s];
                        var setting = null;
                        for (var st = 0; st < settings.length; st++) {
                            if (settings[st].setting_key === settingKey) {
                                setting = settings[st];
                                break;
                            }
                        }
                        if (!setting) continue;

                        var config = setting.config || {};
                        var configControls = '';

                        if (settingKey === 'send_reminders') {
                            var days = config.reminder_days_before ? config.reminder_days_before.join(',') : '1,0';
                            var adminSummaryChecked = config.admin_summary_enabled !== false ? 'checked' : '';
                            var overdueChecked = config.send_overdue_reminders !== false ? 'checked' : '';
                            configControls = '<div class="config-group">'
                                + '<label>Remind days before due: <input type="text" data-key="' + settingKey + '" data-config="reminder_days_before" value="' + escapeHtml(days) + '" placeholder="e.g. 1,0" /></label>'
                                + '<label><input type="checkbox" data-key="' + settingKey + '" data-config="admin_summary_enabled" ' + adminSummaryChecked + ' /> Admin summary</label>'
                                + '<label><input type="checkbox" data-key="' + settingKey + '" data-config="send_overdue_reminders" ' + overdueChecked + ' /> Overdue reminders</label>'
                                + '</div>';
                        } else {
                            if (Object.keys(config).length) {
                                configControls = '<span class="text-xs text-slate-400">' + escapeHtml(JSON.stringify(config)) + '</span>';
                            }
                        }

                        html += '<div class="setting-item">'
                            + '<div class="setting-label">' + escapeHtml(settingKey.replace(/_/g, ' ').replace(/\b\w/g, function(l) { return l.toUpperCase(); })) + '</div>'
                            + '<div class="setting-control">'
                            + '<input type="checkbox" class="setting-toggle" data-key="' + settingKey + '" ' + (setting.enabled ? 'checked' : '') + ' />'
                            + configControls
                            + '</div></div>';
                    }
                }
            }
            container.innerHTML = html;
        } catch (err) {
            container.innerHTML = '<div class="text-center py-8 text-rose-600">Failed to load settings. Please refresh.</div>';
            showAlertModal(err.message || 'Unable to load notification settings.', 'error');
        }
    }

    async function loadAdminRecipients() {
        var container = document.getElementById('adminRecipientsContainer');
        if (!container) return;
        container.innerHTML = '<div class="text-center py-8 text-slate-400">Loading recipients...</div>';

        try {
            var res = await authenticatedFetch('/api/admin/admin-notification-recipients');
            var recipients = await res.json();

            if (!recipients.length) {
                container.innerHTML = '<div class="text-center py-8 text-slate-400">No admin notification recipients configured.</div>';
                return;
            }

            var html = '<table class="table-clean"><thead><tr>'
                + '<th class="text-left">Name</th><th class="text-left">Email</th>'
                + '<th style="text-align:center;">Status</th><th style="text-align:right;">Actions</th>'
                + '</tr></thead><tbody>';

            for (var i = 0; i < recipients.length; i++) {
                var r = recipients[i];
                var statusBadge = r.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700';
                var statusLabel = r.enabled ? 'Active' : 'Disabled';

                html += '<tr><td class="text-left">' + escapeHtml(r.name) + '</td>'
                    + '<td class="text-left">' + escapeHtml(r.email) + '</td>'
                    + '<td style="text-align:center;"><span class="status-badge ' + statusBadge + '">' + statusLabel + '</span></td>'
                    + '<td style="text-align:right;"><div class="action-buttons" style="justify-content:flex-end;">'
                    + '<button class="btn btn-secondary btn-sm toggle-admin-recipient" data-user-id="' + r.id + '" data-enabled="' + r.enabled + '"><i class="fas ' + (r.enabled ? 'fa-pause' : 'fa-play') + '"></i> ' + (r.enabled ? 'Disable' : 'Enable') + '</button>'
                    + '<button class="btn btn-danger btn-sm delete-admin-recipient" data-user-id="' + r.id + '" data-name="' + escapeHtml(r.name) + '"><i class="fas fa-trash"></i> Remove</button>'
                    + '</div></td></tr>';
            }
            html += '</tbody></table>';
            container.innerHTML = html;

            document.querySelectorAll('.toggle-admin-recipient').forEach(function(btn) {
                btn.addEventListener('click', async function() {
                    var userId = parseInt(this.dataset.userId);
                    var currentEnabled = this.dataset.enabled === 'true';
                    var newEnabled = !currentEnabled;

                    try {
                        var res = await authenticatedFetch('/api/admin/admin-notification-recipients', {
                            method: 'POST',
                            body: { user_id: userId, enabled: newEnabled }
                        });
                        if (res.ok) {
                            showAlertModal('Recipient ' + (newEnabled ? 'enabled' : 'disabled') + '.', 'success');
                            loadAdminRecipients();
                        } else {
                            var data = await res.json();
                            showAlertModal(data.error || 'Update failed.', 'error');
                        }
                    } catch (err) {
                        showAlertModal(err.message || 'Network error.', 'error');
                    }
                });
            });

            document.querySelectorAll('.delete-admin-recipient').forEach(function(btn) {
                btn.addEventListener('click', async function() {
                    var userId = parseInt(this.dataset.userId);
                    var name = this.dataset.name;
                    var ok = await showConfirm('Remove ' + name + ' from notification recipients?', { title: 'Remove Recipient' });
                    if (!ok) return;

                    try {
                        var res = await authenticatedFetch('/api/admin/admin-notification-recipients/' + userId, { method: 'DELETE' });
                        if (res.ok) {
                            showAlertModal('Recipient removed successfully.', 'success');
                            loadAdminRecipients();
                        } else {
                            var data = await res.json();
                            showAlertModal(data.error || 'Removal failed.', 'error');
                        }
                    } catch (err) {
                        showAlertModal(err.message || 'Network error.', 'error');
                    }
                });
            });
        } catch (err) {
            container.innerHTML = '<div class="text-center py-8 text-rose-600">Failed to load recipients: ' + escapeHtml(err.message) + '</div>';
            showAlertModal(err.message || 'Failed to load admin notification recipients.', 'error');
        }
    }

    async function openAddAdminRecipientModal() {
        var modal = document.getElementById('addAdminRecipientModal');
        var select = document.getElementById('adminRecipientSelect');
        modal.style.display = 'flex';
        select.innerHTML = '<option value="">Loading...</option>';

        try {
            var res = await authenticatedFetch('/api/admin/admin-notification-recipients/available');
            var users = await res.json();

            if (!users.length) {
                select.innerHTML = '<option value="">No available admins</option>';
                return;
            }

            select.innerHTML = '<option value="">Select admin user...</option>';
            for (var i = 0; i < users.length; i++) {
                var user = users[i];
                var opt = document.createElement('option');
                opt.value = user.id;
                opt.textContent = user.name + ' (' + user.email + ')';
                select.appendChild(opt);
            }
        } catch (err) {
            select.innerHTML = '<option value="">Error loading users</option>';
            showAlertModal(err.message || 'Failed to load available admins.', 'error');
        }
    }

    // ==================== SECURITY ====================
    async function loadSecurityTab() {
        if (securityLoaded) return;
        securityLoaded = true;
        await Promise.all([
            loadAuditLogs(),
            loadAuditHealth(),
            loadPermissions(),
            loadRolesForUsers()
        ]);
        initAuditLogFilters();
    }

    async function loadPermissions() {
        var container = document.getElementById('permissionsContainer');
        container.innerHTML = '<div class="text-center text-slate-400 py-8">Loading permissions...</div>';

        try {
            var results = await Promise.all([
                authenticatedFetch('/api/permissions/roles'),
                authenticatedFetch('/api/permissions')
            ]);
            if (!results[0].ok || !results[1].ok) throw new Error('Failed to load permissions data');

            var roleMappings = await results[0].json();
            var permissions = await results[1].json();

            var normalizedMappings = {};
            if (Array.isArray(roleMappings)) {
                for (var i = 0; i < roleMappings.length; i++) {
                    var item = roleMappings[i];
                    var roleName = item.role || item.role_name || 'unknown';
                    var perms = item.permissions || item.permission_codes || [];
                    normalizedMappings[roleName] = Array.isArray(perms) ? perms : [];
                }
            } else if (roleMappings && typeof roleMappings === 'object') {
                normalizedMappings = roleMappings;
            } else {
                normalizedMappings = { admin: [] };
            }

            for (var key in normalizedMappings) {
                if (normalizedMappings.hasOwnProperty(key)) {
                    if (!Array.isArray(normalizedMappings[key])) {
                        normalizedMappings[key] = [];
                    }
                }
            }

            permissionsData.roleMappings = normalizedMappings;
            permissionsData.permissions = Array.isArray(permissions) ? permissions : [];
            permissionsData.roles = [];
            for (var roleKey in normalizedMappings) {
                if (normalizedMappings.hasOwnProperty(roleKey)) {
                    permissionsData.roles.push(roleKey);
                }
            }
            renderPermissions();
        } catch (err) {
            container.innerHTML = '<div class="text-rose-600 text-center py-8">Error: ' + escapeHtml(err.message) + '</div>';
            showAlertModal(err.message || 'Unable to load permissions.', 'error');
        }
    }

    function renderPermissions() {
        var container = document.getElementById('permissionsContainer');
        var roles = permissionsData.roles;
        var permissions = permissionsData.permissions;
        var roleMappings = permissionsData.roleMappings;

        if (!permissions || permissions.length === 0) {
            container.innerHTML = '<div class="text-center py-8 text-amber-600">No permissions defined.</div>';
            return;
        }
        if (!roles || roles.length === 0) {
            container.innerHTML = '<div class="text-center py-8 text-amber-600">No roles found.</div>';
            return;
        }

        var html = '<table class="table-clean"><thead><tr><th class="text-left">Role</th>';
        for (var p = 0; p < permissions.length; p++) {
            html += '<th>' + escapeHtml(permissions[p].permission_name) + '</th>';
        }
        html += '<th>Actions</th></tr></thead><tbody>';

        for (var r = 0; r < roles.length; r++) {
            var role = roles[r];
            var perms = Array.isArray(roleMappings[role]) ? roleMappings[role] : [];
            html += '<tr><td class="text-left font-medium text-slate-800">' + escapeHtml(role) + '</td>';

            for (var p2 = 0; p2 < permissions.length; p2++) {
                var perm = permissions[p2];
                var checked = false;
                for (var cp = 0; cp < perms.length; cp++) {
                    if (perms[cp] === perm.permission_code || perms[cp] === String(perm.permission_id)) {
                        checked = true;
                        break;
                    }
                }
                html += '<td><input type="checkbox" class="permission-checkbox" data-role="' + escapeHtml(role) + '" data-perm-id="' + perm.permission_id + '" ' + (checked ? 'checked' : '') + '></td>';
            }

            if (role.toLowerCase() === 'admin') {
                html += '<td><button class="btn btn-secondary btn-sm viewRoleBtn" data-role="' + escapeHtml(role) + '"><i class="fas fa-eye"></i> View</button></td>';
            } else {
                html += '<td><button class="btn btn-danger btn-sm deleteRoleBtn" data-role="' + escapeHtml(role) + '"><i class="fas fa-trash"></i> Delete</button></td>';
            }
            html += '</tr>';
        }
        html += '</tbody></table>';
        container.innerHTML = html;

        document.querySelectorAll('.deleteRoleBtn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var role = this.dataset.role;
                showConfirm('Delete role "' + role + '"?', { title: 'Delete Role' }).then(function(ok) {
                    if (!ok) return;
                    delete permissionsData.roleMappings[role];
                    permissionsData.roles = [];
                    for (var key in permissionsData.roleMappings) {
                        if (permissionsData.roleMappings.hasOwnProperty(key)) {
                            permissionsData.roles.push(key);
                        }
                    }
                    renderPermissions();
                    showAlertModal('Role "' + role + '" removed.', 'info');
                });
            });
        });

        document.querySelectorAll('.viewRoleBtn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var role = this.dataset.role;
                var perms = Array.isArray(permissionsData.roleMappings[role]) ? permissionsData.roleMappings[role] : [];
                var permNames = [];
                for (var i = 0; i < permissionsData.permissions.length; i++) {
                    var p = permissionsData.permissions[i];
                    for (var j = 0; j < perms.length; j++) {
                        if (perms[j] === p.permission_code || perms[j] === String(p.permission_id)) {
                            permNames.push(p.permission_name);
                            break;
                        }
                    }
                }
                var displayNames = permNames.length ? permNames.join(', ') : 'No permissions assigned';

                showDetailModal('Permissions for "' + role + '"',
                    '<div class="p-4"><p><strong>Role:</strong> ' + escapeHtml(role) + '</p>'
                    + '<p><strong>Permissions:</strong> ' + escapeHtml(displayNames) + '</p>'
                    + '<p class="text-xs text-slate-500 mt-2">System admin role – cannot be deleted.</p></div>'
                );
            });
        });

        document.querySelectorAll('.permission-checkbox').forEach(function(cb) {
            cb.style.pointerEvents = 'auto';
            cb.style.cursor = 'pointer';
            cb.style.opacity = '1';
            cb.disabled = false;
        });
    }

    async function loadRolesForUsers() {
        try {
            var res = await authenticatedFetch('/api/permissions/roles');
            var data = await res.json();
            var roleNames = [];
            for (var key in data) {
                if (data.hasOwnProperty(key)) {
                    roleNames.push(key);
                }
            }
            allRolesList = roleNames;
            populateRoleDropdowns(roleNames);
        } catch (err) {
            showAlertModal(err.message || 'Failed to load roles.', 'error');
        }
    }

    function populateRoleDropdowns(roles) {
        var filterSelect = document.getElementById('acmRoleFilter');
        if (filterSelect) {
            filterSelect.innerHTML = '<option value="all">All roles</option>';
            for (var i = 0; i < roles.length; i++) {
                var opt = document.createElement('option');
                opt.value = roles[i];
                opt.textContent = roles[i];
                filterSelect.appendChild(opt);
            }
        }

        var modalSelect = document.getElementById('acmRole');
        if (modalSelect) {
            modalSelect.innerHTML = '<option value="">Select role...</option>';
            for (var i = 0; i < roles.length; i++) {
                var opt = document.createElement('option');
                opt.value = roles[i];
                opt.textContent = roles[i];
                modalSelect.appendChild(opt);
            }
        }

        var manageRoleFilter = document.getElementById('manageUserRoleFilter');
        if (manageRoleFilter) {
            manageRoleFilter.innerHTML = '<option value="all">All roles</option>';
            for (var i = 0; i < roles.length; i++) {
                var opt = document.createElement('option');
                opt.value = roles[i];
                opt.textContent = roles[i];
                manageRoleFilter.appendChild(opt);
            }
        }
    }

    // ==================== USER MANAGEMENT ====================
    function initUserManagement() {
        var tbody = document.getElementById('acmUserTableBody');
        var searchInput = document.getElementById('acmSearchInput');
        var roleFilter = document.getElementById('acmRoleFilter');
        var statusFilter = document.getElementById('acmStatusFilter');
        var resetBtn = document.getElementById('acmResetFiltersBtn');
        var prevBtn = document.getElementById('acmPrevPageBtn');
        var nextBtn = document.getElementById('acmNextPageBtn');
        var paginationInfo = document.getElementById('acmPaginationInfo');
        var allUsers = [];
        var filteredUsers = [];
        var currentPage = 1;
        var rowsPerPage = 5;
        var totalUsers = 0;

        var manageModal = document.getElementById('userManagementModal');
        var manageTbody = document.getElementById('manageUserTableBody');
        var manageSearch = document.getElementById('manageUserSearch');
        var manageRoleFilter = document.getElementById('manageUserRoleFilter');
        var manageStatusFilter = document.getElementById('manageUserStatusFilter');
        var manageResetBtn = document.getElementById('resetManageUserFilters');
        var managePrevBtn = document.getElementById('manageUserPrevBtn');
        var manageNextBtn = document.getElementById('manageUserNextBtn');
        var managePaginationInfo = document.getElementById('manageUserPaginationInfo');
        var addUserFromManageBtn = document.getElementById('addUserFromManageBtn');
        var manageTotalLabel = document.getElementById('manageUserTotalLabel');
        var manageUsers = [];
        var manageFiltered = [];
        var managePage = 1;
        var manageRows = 5;
        var manageTotal = 0;

        document.getElementById('openUserManagementBtn') && document.getElementById('openUserManagementBtn').addEventListener('click', function() {
            manageModal.style.display = 'flex';
            fetchManageUsers();
        });
        document.getElementById('closeUserManagementModalBtn') && document.getElementById('closeUserManagementModalBtn').addEventListener('click', function() {
            manageModal.style.display = 'none';
        });
        manageModal && manageModal.addEventListener('click', function(e) {
            if (e.target === e.currentTarget) manageModal.style.display = 'none';
        });

        async function fetchUsersInline() {
            var search = searchInput.value.trim();
            var role = roleFilter.value;
            var status = statusFilter.value;
            var params = new URLSearchParams();
            if (search) params.append('search', search);
            if (role !== 'all') params.append('role', role);
            if (status !== 'all') params.append('status', status);
            params.append('page', currentPage);
            params.append('limit', rowsPerPage);
            params.append('_', Date.now());

            try {
                var res = await authenticatedFetch('/api/admin/users?' + params.toString(), { cache: 'no-store' });
                var data = await res.json();
                allUsers = data.users || [];
                totalUsers = data.total || 0;
                filteredUsers = allUsers;
                renderInlineTable();
                updateInlinePagination();
            } catch (err) {
                tbody.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-rose-600">Unable to load users. Please refresh.</td></tr>';
                showAlertModal(err.message || 'Failed to load users.', 'error');
            }
        }

        function renderInlineTable() {
            if (!filteredUsers.length) {
                tbody.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-slate-400">No users found</td></tr>';
                return;
            }

            var html = '';
            for (var i = 0; i < filteredUsers.length; i++) {
                var user = filteredUsers[i];
                var statusBadge = user.status === 'active' ? 'bg-emerald-100 text-emerald-700' :
                    user.status === 'suspended' ? 'bg-rose-100 text-rose-700' :
                    user.status === 'locked' ? 'bg-amber-100 text-amber-700' : 'bg-amber-100 text-amber-700';
                var statusLabel = user.status.charAt(0).toUpperCase() + user.status.slice(1);

                html += '<tr class="hover:bg-slate-50 transition">'
                    + '<td style="text-align:center;"><div><div class="text-sm font-medium text-slate-800">' + escapeHtml(user.name || 'User') + '</div>'
                    + '<div class="text-sm text-slate-500">' + escapeHtml(user.email) + '</div></div></td>'
                    + '<td style="text-align:center;">' + escapeHtml(user.role) + '</td>'
                    + '<td style="text-align:center;"><span class="status-badge ' + statusBadge + '">' + statusLabel + '</span></td>'
                    + '<td style="text-align:center;">' + formatLastActive(user.lastActive) + '</td></tr>';
            }
            tbody.innerHTML = html;
        }

        function updateInlinePagination() {
            var start = (currentPage - 1) * rowsPerPage + 1;
            var end = Math.min(currentPage * rowsPerPage, totalUsers);
            paginationInfo.innerText = totalUsers === 0 ?
                'Showing 0 of 0 users' :
                'Showing ' + start + '–' + end + ' of ' + totalUsers + ' users';
            var totalPages = Math.ceil(totalUsers / rowsPerPage);
            prevBtn.disabled = currentPage === 1 || totalPages === 0;
            nextBtn.disabled = currentPage === totalPages || totalPages === 0;
        }

        searchInput && searchInput.addEventListener('input', function() { currentPage = 1; fetchUsersInline(); });
        roleFilter && roleFilter.addEventListener('change', function() { currentPage = 1; fetchUsersInline(); });
        statusFilter && statusFilter.addEventListener('change', function() { currentPage = 1; fetchUsersInline(); });
        resetBtn && resetBtn.addEventListener('click', function() {
            searchInput.value = '';
            roleFilter.value = 'all';
            statusFilter.value = 'all';
            currentPage = 1;
            fetchUsersInline();
        });
        prevBtn && prevBtn.addEventListener('click', function() {
            if (currentPage > 1) { currentPage--; fetchUsersInline(); }
        });
        nextBtn && nextBtn.addEventListener('click', function() {
            var totalPages = Math.ceil(totalUsers / rowsPerPage);
            if (currentPage < totalPages) { currentPage++; fetchUsersInline(); }
        });
        document.getElementById('acmRowsPerPage') && document.getElementById('acmRowsPerPage').addEventListener('change', function() {
            rowsPerPage = parseInt(this.value);
            currentPage = 1;
            fetchUsersInline();
        });

        fetchUsersInline();

        var userModal = document.getElementById('acmUserModal');
        var modalTitle = document.getElementById('acmModalTitle');
        var closeModalBtn = document.getElementById('acmCloseModalBtn');
        var cancelModalBtn = document.getElementById('acmCancelModalBtn');
        var saveUserBtn = document.getElementById('acmSaveUserBtn');
        var deleteConfirmModal = document.getElementById('acmDeleteConfirmModal');
        var cancelDeleteBtn = document.getElementById('acmCancelDeleteBtn');
        var confirmDeleteBtn = document.getElementById('acmConfirmDeleteBtn');
        var editUserId = null;
        var deleteUserId = null;

        async function fetchManageUsers() {
            var search = manageSearch.value.trim();
            var role = manageRoleFilter.value;
            var status = manageStatusFilter.value;
            var params = new URLSearchParams();
            if (search) params.append('search', search);
            if (role !== 'all') params.append('role', role);
            if (status !== 'all') params.append('status', status);
            params.append('page', managePage);
            params.append('limit', manageRows);
            params.append('_', Date.now());

            try {
                var res = await authenticatedFetch('/api/admin/users?' + params.toString(), { cache: 'no-store' });
                var data = await res.json();
                manageUsers = data.users || [];
                manageTotal = data.total || 0;
                manageFiltered = manageUsers;
                renderManageTable();
                updateManagePagination();
                if (manageTotalLabel) manageTotalLabel.textContent = 'Total: ' + manageTotal;
            } catch (err) {
                manageTbody.innerHTML = '<tr><td colspan="5" class="text-center py-8 text-rose-600">Unable to load users. Please refresh.</td></tr>';
                showAlertModal(err.message || 'Failed to load users.', 'error');
            }
        }

        function renderManageTable() {
            if (!manageFiltered.length) {
                manageTbody.innerHTML = '<tr><td colspan="5" class="text-center py-8 text-slate-400">No users found</td></tr>';
                return;
            }

            var html = '';
            for (var i = 0; i < manageFiltered.length; i++) {
                var user = manageFiltered[i];
                var statusBadge = user.status === 'active' ? 'bg-emerald-100 text-emerald-700' :
                    user.status === 'suspended' ? 'bg-rose-100 text-rose-700' :
                    user.status === 'locked' ? 'bg-amber-100 text-amber-700' : 'bg-amber-100 text-amber-700';
                var statusLabel = user.status.charAt(0).toUpperCase() + user.status.slice(1);

                html += '<tr class="hover:bg-slate-50 transition">'
                    + '<td style="text-align:center;"><div><div class="text-sm font-medium text-slate-800">' + escapeHtml(user.name || 'User') + '</div>'
                    + '<div class="text-sm text-slate-500">' + escapeHtml(user.email) + '</div></div></td>'
                    + '<td style="text-align:center;">' + escapeHtml(user.role) + '</td>'
                    + '<td style="text-align:center;"><span class="status-badge ' + statusBadge + '">' + statusLabel + '</span></td>'
                    + '<td style="text-align:center;">' + formatLastActive(user.lastActive) + '</td>'
                    + '<td style="text-align:center;"><button class="btn btn-sm btn-ghost manageActionDots" data-user-id="' + user.id + '"><i class="fas fa-ellipsis-v"></i></button></td></tr>';
            }
            manageTbody.innerHTML = html;
            attachManageEvents();
        }

        function attachManageEvents() {
            document.querySelectorAll('.manageActionDots').forEach(function(btn) {
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    var userId = parseInt(this.dataset.userId);
                    var user = null;
                    for (var i = 0; i < manageUsers.length; i++) {
                        if (manageUsers[i].id === userId) {
                            user = manageUsers[i];
                            break;
                        }
                    }
                    if (!user) return;

                    var menuHtml = '<button class="menu-item" data-action="edit"><i class="fas fa-edit"></i> Edit</button>'
                        + '<button class="menu-item" data-action="suspend"><i class="fas fa-ban"></i> ' + (user.status === 'suspended' ? 'Unsuspend' : 'Suspend') + '</button>'
                        + (user.status === 'locked' ? '<button class="menu-item" data-action="unlock"><i class="fas fa-unlock"></i> Unlock</button>' : '')
                        + '<button class="menu-item" data-action="send-welcome"><i class="fas fa-envelope"></i> Send Welcome Email</button>'
                        + '<div class="menu-divider"></div>'
                        + '<button class="menu-item danger" data-action="delete"><i class="fas fa-trash"></i> Deactivate</button>';

                    openPortalMenu(this, menuHtml, function(menu) {
                        menu.querySelector('[data-action="edit"]') && menu.querySelector('[data-action="edit"]').addEventListener('click', function() {
                            menu.remove();
                            editUserId = user.id;
                            document.getElementById('acmFullName').value = user.name;
                            document.getElementById('acmEmail').value = user.email;
                            document.getElementById('acmRole').value = user.role;
                            document.getElementById('acmStatus').value = user.status;
                            modalTitle.innerText = 'Edit User';
                            userModal.classList.add('active');
                            manageModal.style.display = 'none';
                        });

                        menu.querySelector('[data-action="suspend"]') && menu.querySelector('[data-action="suspend"]').addEventListener('click', async function() {
                            menu.remove();
                            try {
                                var res = await authenticatedFetch('/api/admin/users/' + user.id + '/suspend', { method: 'PATCH' });
                                var data = await res.json();
                                showAlertModal('User ' + user.name + ' ' + (data.status === 'suspended' ? 'suspended' : 'activated') + '.', 'success');
                                fetchManageUsers();
                                fetchUsersInline();
                            } catch (err) {
                                showAlertModal(err.message || 'Network error.', 'error');
                            }
                        });

                        menu.querySelector('[data-action="unlock"]') && menu.querySelector('[data-action="unlock"]').addEventListener('click', async function() {
                            menu.remove();
                            var ok = await showConfirm('Unlock account for ' + user.name + '?', {
                                title: 'Unlock Account',
                                danger: false,
                                okLabel: 'Unlock'
                            });
                            if (!ok) return;
                            try {
                                await authenticatedFetch('/api/admin/users/' + user.id + '/unlock', { method: 'POST' });
                                showAlertModal('User ' + user.name + ' unlocked.', 'success');
                                fetchManageUsers();
                                fetchUsersInline();
                            } catch (err) {
                                showAlertModal(err.message || 'Network error.', 'error');
                            }
                        });

                        menu.querySelector('[data-action="send-welcome"]') && menu.querySelector('[data-action="send-welcome"]').addEventListener('click', async function() {
                            menu.remove();
                            var ok = await showConfirm('Send welcome email to ' + user.name + ' (' + user.email + ')?', {
                                title: 'Send Welcome Email',
                                danger: false,
                                okLabel: 'Send Email'
                            });
                            if (!ok) return;
                            try {
                                var res = await authenticatedFetch('/api/admin/users/' + user.id + '/send-welcome', { method: 'POST' });
                                var data = await res.json();
                                if (res.ok) {
                                    showAlertModal(data.message || 'Welcome email sent successfully.', 'success');
                                } else {
                                    showAlertModal(data.error || 'Failed to send email.', 'error');
                                }
                            } catch (err) {
                                showAlertModal(err.message || 'Network error.', 'error');
                            }
                        });

                        menu.querySelector('[data-action="delete"]') && menu.querySelector('[data-action="delete"]').addEventListener('click', function() {
                            menu.remove();
                            deleteUserId = user.id;
                            document.getElementById('acmDeleteUserMessage').innerHTML =
                                '⚠️ <strong>Deactivate User</strong><br><br>'
                                + 'Are you sure you want to deactivate <strong>' + escapeHtml(user.name) + '</strong>?<br><br>'
                                + '<span style="color:#64748b;font-size:0.9rem;">'
                                + 'This will:<br>'
                                + '• Set the user\'s status to "inactive"<br>'
                                + '• Preserve all associated records (audit logs, notifications, etc.)<br>'
                                + '• Maintain referential integrity with foreign keys<br>'
                                + '• Allow reactivation if needed in the future<br>'
                                + '</span><br><br>'
                                + '<strong>This is a soft delete. The user record is preserved.</strong>';
                            deleteConfirmModal.classList.add('active');
                            deleteConfirmModal.style.zIndex = '1000001';
                        });
                    });
                });
            });
        }

        function updateManagePagination() {
            var start = (managePage - 1) * manageRows + 1;
            var end = Math.min(managePage * manageRows, manageTotal);
            managePaginationInfo.innerText = manageTotal === 0 ?
                'Showing 0 of 0 users' :
                'Showing ' + start + '–' + end + ' of ' + manageTotal + ' users';
            var totalPages = Math.ceil(manageTotal / manageRows);
            managePrevBtn.disabled = managePage === 1 || totalPages === 0;
            manageNextBtn.disabled = managePage === totalPages || totalPages === 0;
        }

        manageSearch && manageSearch.addEventListener('input', function() { managePage = 1; fetchManageUsers(); });
        manageRoleFilter && manageRoleFilter.addEventListener('change', function() { managePage = 1; fetchManageUsers(); });
        manageStatusFilter && manageStatusFilter.addEventListener('change', function() { managePage = 1; fetchManageUsers(); });
        manageResetBtn && manageResetBtn.addEventListener('click', function() {
            manageSearch.value = '';
            manageRoleFilter.value = 'all';
            manageStatusFilter.value = 'all';
            managePage = 1;
            fetchManageUsers();
        });
        managePrevBtn && managePrevBtn.addEventListener('click', function() {
            if (managePage > 1) { managePage--; fetchManageUsers(); }
        });
        manageNextBtn && manageNextBtn.addEventListener('click', function() {
            var totalPages = Math.ceil(manageTotal / manageRows);
            if (managePage < totalPages) { managePage++; fetchManageUsers(); }
        });

        addUserFromManageBtn && addUserFromManageBtn.addEventListener('click', function() {
            resetForm();
            openUserModal();
            manageModal.style.display = 'none';
        });

        function closeUserModal() { userModal.classList.remove('active'); }

        function openUserModal() { userModal.classList.add('active'); }

        function resetForm() {
            editUserId = null;
            document.getElementById('acmFullName').value = '';
            document.getElementById('acmEmail').value = '';
            document.getElementById('acmRole').value = '';
            document.getElementById('acmStatus').value = 'active';
            modalTitle.innerText = 'Add New User';
        }

        async function saveUser() {
            var name = document.getElementById('acmFullName').value.trim();
            var email = document.getElementById('acmEmail').value.trim();
            var role = document.getElementById('acmRole').value;
            var status = document.getElementById('acmStatus').value;

            if (!name || !email) {
                showAlertModal('Name and email are required', 'error');
                return;
            }
            if (!role) {
                showAlertModal('Please select a role.', 'error');
                return;
            }

            saveUserBtn.disabled = true;
            saveUserBtn.innerText = 'Saving...';

            try {
                var payload = { name: name, email: email, role: role, status: status };
                var res;
                if (editUserId) {
                    res = await authenticatedFetch('/api/admin/users/' + editUserId, { method: 'PUT', body: payload });
                } else {
                    res = await authenticatedFetch('/api/admin/users', { method: 'POST', body: payload });
                }
                var data = await res.json();

                if (res.ok) {
                    showAlertModal(editUserId ? 'User updated successfully.' : 'User ' + data.name + ' created successfully.', 'success');
                    closeUserModal();
                    fetchUsersInline();
                    fetchManageUsers();
                } else {
                    showAlertModal(data.error || 'Operation failed.', 'error');
                }
            } catch (err) {
                showAlertModal(err.message || 'Network error.', 'error');
            } finally {
                saveUserBtn.disabled = false;
                saveUserBtn.innerText = 'Save User';
            }
        }

        function closeDeleteModal() { deleteConfirmModal.classList.remove('active'); }

        async function confirmDelete() {
            if (!deleteUserId) return;
            confirmDeleteBtn.disabled = true;
            confirmDeleteBtn.innerText = 'Deactivating...';

            try {
                var res = await authenticatedFetch('/api/admin/users/' + deleteUserId + '/deactivate', { method: 'PATCH' });

                if (res.ok) {
                    showAlertModal('User has been deactivated (soft delete). The record is preserved for audit and FK integrity.', 'success');
                    closeDeleteModal();
                    deleteUserId = null;
                    fetchUsersInline();
                    fetchManageUsers();
                } else {
                    var data = await res.json();
                    showAlertModal(data.error || 'Deactivation failed.', 'error');
                }
            } catch (err) {
                showAlertModal(err.message || 'Network error.', 'error');
            } finally {
                confirmDeleteBtn.disabled = false;
                confirmDeleteBtn.innerText = 'Deactivate';
            }
        }

        closeModalBtn && closeModalBtn.addEventListener('click', closeUserModal);
        cancelModalBtn && cancelModalBtn.addEventListener('click', closeUserModal);
        saveUserBtn && saveUserBtn.addEventListener('click', saveUser);
        cancelDeleteBtn && cancelDeleteBtn.addEventListener('click', closeDeleteModal);
        confirmDeleteBtn && confirmDeleteBtn.addEventListener('click', confirmDelete);
        userModal && userModal.addEventListener('click', function(e) {
            if (e.target === userModal) closeUserModal();
        });
        deleteConfirmModal && deleteConfirmModal.addEventListener('click', function(e) {
            if (e.target === deleteConfirmModal) closeDeleteModal();
        });
    }

    // ==================== PENDING REGISTRATIONS ====================
    async function loadPendingRegistrations() {
        var container = document.getElementById('pendingRequestsContainer');
        container.innerHTML = '<div class="text-center py-8 text-slate-400">Loading requests...</div>';

        try {
            var res = await authenticatedFetch('/api/auth/admin/pending-requests');
            var requests = await res.json();

            if (!requests.length) {
                container.innerHTML = '<div class="text-center py-8 text-slate-400">No pending requests.</div>';
                return;
            }

            var html = '<table class="table-clean"><thead><tr>'
                + '<th style="text-align:center;">Name</th><th style="text-align:center;">Email</th>'
                + '<th style="text-align:center;">Username</th><th style="text-align:center;">Requested</th>'
                + '<th style="text-align:center;">Actions</th>'
                + '</tr></thead><tbody>';

            for (var i = 0; i < requests.length; i++) {
                var req = requests[i];
                html += '<tr><td style="text-align:center;">' + escapeHtml(req.name) + '</td>'
                    + '<td style="text-align:center;">' + escapeHtml(req.email) + '</td>'
                    + '<td style="text-align:center;">' + escapeHtml(req.username || '—') + '</td>'
                    + '<td style="text-align:center;">' + formatDate(req.created_at) + '</td>'
                    + '<td style="text-align:center;"><button class="btn btn-sm btn-ghost registration-actions-btn" data-id="' + req.id + '" data-name="' + escapeHtml(req.name) + '"><i class="fas fa-ellipsis-v"></i></button></td></tr>';
            }
            html += '</tbody></table>';
            container.innerHTML = html;

            container.querySelectorAll('.registration-actions-btn').forEach(function(btn) {
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    var id = parseInt(this.dataset.id);
                    var name = this.dataset.name;

                    var menuHtml = '<button class="menu-item approve-registration" data-id="' + id + '"><i class="fas fa-check-circle"></i> Approve</button>'
                        + '<button class="menu-item danger reject-registration" data-id="' + id + '"><i class="fas fa-times-circle"></i> Reject</button>';

                    openPortalMenu(this, menuHtml, function(menu) {
                        menu.querySelector('.approve-registration').addEventListener('click', function() {
                            menu.remove();
                            handleApproveRegistration(id);
                        });

                        menu.querySelector('.reject-registration').addEventListener('click', function() {
                            menu.remove();
                            handleRejectRegistration(id);
                        });
                    });
                });
            });
        } catch (err) {
            container.innerHTML = '<div class="text-center py-8 text-rose-600">Failed to load requests. Please refresh the page.</div>';
            showAlertModal(err.message || 'Unable to load pending requests.', 'error');
        }
    }

    async function handleApproveRegistration(id) {
        var ok = await showConfirm('Approve this registration request?', {
            title: 'Approve Request',
            danger: false,
            okLabel: 'Approve'
        });
        if (!ok) return;

        try {
            var res = await authenticatedFetch('/api/auth/admin/pending-requests/' + id + '/approve', { method: 'POST' });
            var data = await res.json();

            if (res.ok) {
                showAlertModal(data.message || 'User approved. Password sent.', 'success');
                loadPendingRegistrations();
            } else {
                showAlertModal(data.error || 'Approval failed.', 'error');
            }
        } catch (err) {
            showAlertModal(err.message || 'Network error.', 'error');
        }
    }

    async function handleRejectRegistration(id) {
        var reason = await showPromptModal('Optional reason for rejection:', {
            title: 'Reject Request',
            placeholder: 'Reason (optional)'
        });
        if (reason === undefined) return;

        var ok = await showConfirm('Reject this registration request?', { title: 'Reject Request' });
        if (!ok) return;

        try {
            var res = await authenticatedFetch('/api/auth/admin/pending-requests/' + id + '/reject', {
                method: 'POST',
                body: { reason: reason || null }
            });
            var data = await res.json();

            if (res.ok) {
                showAlertModal('Request rejected successfully.', 'success');
                loadPendingRegistrations();
            } else {
                showAlertModal(data.error || 'Rejection failed.', 'error');
            }
        } catch (err) {
            showAlertModal(err.message || 'Network error.', 'error');
        }
    }

    // ==================== PROFILE ====================
    function openProfileModal() {
        var user = getUser();
        if (user) {
            authenticatedFetch('/api/user/profile')
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    document.getElementById('profileName').value = data.name || '';
                    document.getElementById('profileEmail').value = data.email || '';
                    document.getElementById('profileCurrentPassword').value = '';
                    document.getElementById('profilePassword').value = '';
                })
                .catch(function() {
                    document.getElementById('profileName').value = user.name || '';
                    document.getElementById('profileEmail').value = user.email || '';
                });
        }
        document.getElementById('profileModal').style.display = 'flex';
        var mobileMenu = document.getElementById('mobileMenu');
        if (mobileMenu) mobileMenu.classList.remove('open');
    }

    // ==================== LOGOUT ====================
    async function handleLogout() {
        if (isRedirecting) return;
        isRedirecting = true;

        try {
            var token = getToken();
            if (token) {
                await fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + token,
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-cache, no-store'
                    },
                    credentials: 'include'
                }).catch(function() {});
            }
        } catch (error) {
            console.error('Logout error:', error);
        } finally {
            window.location.replace('/force-logout');
        }
    }

    // ==================== AUTH ====================
    async function checkAuth() {
        try {
            var token = getToken();
            if (!token) {
                if (!isRedirecting) redirectToLogin();
                return false;
            }

            var response = await fetch('/api/auth/check-session', {
                credentials: 'include',
                headers: { 'Accept': 'application/json' }
            });

            if (!response.ok) {
                if (!isRedirecting) redirectToLogin();
                return false;
            }

            var data = await response.json();
            if (!data.authenticated) {
                if (!isRedirecting) redirectToLogin();
                return false;
            }

            if (data.user) {
                try {
                    var profileRes = await fetch('/api/user/profile', {
                        credentials: 'include',
                        headers: {
                            'Authorization': 'Bearer ' + token,
                            'Accept': 'application/json'
                        }
                    });
                    if (profileRes.ok) {
                        var profileData = await profileRes.json();
                        data.user.name = profileData.name || data.user.name || 'User';
                        data.user.email = profileData.email || data.user.email;
                        data.user.role = profileData.role || data.user.role || 'user';
                    }
                } catch (profileErr) {
                    if (!data.user.name) data.user.name = 'User';
                }
                if (!data.user.name || data.user.name.trim() === '') {
                    data.user.name = 'User';
                }
                localStorage.setItem('kms_user', JSON.stringify(data.user));
            }

            if (data.user.role !== 'admin') {
                var accessDenied = document.getElementById('accessDenied');
                var loadingContainer = document.getElementById('loadingContainer');
                if (accessDenied) accessDenied.style.display = 'flex';
                if (loadingContainer) loadingContainer.style.display = 'none';
                return false;
            }

            return true;
        } catch (error) {
            console.error('Auth check failed:', error);
            if (!isRedirecting) redirectToLogin();
            return false;
        }
    }

    // ==================== EVENT LISTENERS ====================
    function initEventListeners() {
        document.getElementById('alertOkBtn') && document.getElementById('alertOkBtn').addEventListener('click', closeAlertModal);
        document.getElementById('alertModal') && document.getElementById('alertModal').addEventListener('click', function(e) {
            if (e.target === this) closeAlertModal();
        });

        document.getElementById('closeDetailModalBtn') && document.getElementById('closeDetailModalBtn').addEventListener('click', closeDetailModal);
        document.getElementById('closeDetailModalFooterBtn') && document.getElementById('closeDetailModalFooterBtn').addEventListener('click', closeDetailModal);
        document.getElementById('detailModal') && document.getElementById('detailModal').addEventListener('click', function(e) {
            if (e.target === e.currentTarget) closeDetailModal();
        });

        document.getElementById('brandHomeLink') && document.getElementById('brandHomeLink').addEventListener('click', function(e) {
            e.preventDefault();
            var dashboardTab = document.querySelector('.tab-button[data-tab="dashboard"]');
            if (dashboardTab) dashboardTab.click();
        });

        var mobileMenuBtn = document.getElementById('mobileMenuBtn');
        var mobileMenu = document.getElementById('mobileMenu');
        if (mobileMenuBtn && mobileMenu) {
            mobileMenuBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                mobileMenu.classList.toggle('open');
            });
            document.addEventListener('click', function(e) {
                if (!e.target.closest('.top-nav')) {
                    mobileMenu.classList.remove('open');
                }
            });
        }

        document.getElementById('mobileLogoutBtn') && document.getElementById('mobileLogoutBtn').addEventListener('click', handleLogout);
        document.getElementById('logoutBtn') && document.getElementById('logoutBtn').addEventListener('click', handleLogout);

        document.getElementById('myProfileBtn') && document.getElementById('myProfileBtn').addEventListener('click', openProfileModal);
        document.getElementById('mobileProfileBtn') && document.getElementById('mobileProfileBtn').addEventListener('click', openProfileModal);

        document.getElementById('closeProfileModalBtn') && document.getElementById('closeProfileModalBtn').addEventListener('click', function() {
            document.getElementById('profileModal').style.display = 'none';
        });
        document.getElementById('cancelProfileBtn') && document.getElementById('cancelProfileBtn').addEventListener('click', function() {
            document.getElementById('profileModal').style.display = 'none';
        });
        document.getElementById('profileModal') && document.getElementById('profileModal').addEventListener('click', function(e) {
            if (e.target === e.currentTarget) {
                document.getElementById('profileModal').style.display = 'none';
            }
        });

        document.getElementById('saveProfileBtn') && document.getElementById('saveProfileBtn').addEventListener('click', async function() {
            var name = document.getElementById('profileName').value.trim();
            var email = document.getElementById('profileEmail').value.trim();
            var currentPassword = document.getElementById('profileCurrentPassword').value.trim();
            var newPassword = document.getElementById('profilePassword').value.trim();

            if (!name || !email) {
                showAlertModal('Name and email are required.', 'error');
                return;
            }

            var payload = { name: name, email: email };
            if (newPassword) {
                if (!currentPassword) {
                    showAlertModal('Current password is required to change password.', 'error');
                    return;
                }
                payload.current_password = currentPassword;
                payload.new_password = newPassword;
            }

            try {
                var res = await authenticatedFetch('/api/user/profile', {
                    method: 'PUT',
                    body: payload
                });
                var data = await res.json();

                if (res.ok) {
                    showAlertModal('Profile updated successfully.', 'success');
                    var user = getUser();
                    if (user) {
                        user.name = name;
                        user.email = email;
                        localStorage.setItem('kms_user', JSON.stringify(user));
                    }
                    document.getElementById('profileModal').style.display = 'none';
                } else {
                    showAlertModal(data.error || 'Failed to update profile.', 'error');
                }
            } catch (err) {
                showAlertModal(err.message || 'Network error.', 'error');
            }
        });

        document.querySelectorAll('.tab-button').forEach(function(btn) {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.tab-button').forEach(function(b) { b.classList.remove('active'); });
                this.classList.add('active');
                var tabId = this.dataset.tab;
                document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
                var panel = document.getElementById('tab-' + tabId);
                if (panel) panel.classList.add('active');

                if (tabId === 'security') {
                    var first = document.querySelector('#tab-security .sub-tab-button');
                    if (first) first.click();
                    loadSecurityTab();
                } else if (tabId === 'email') {
                    var first = document.querySelector('#tab-email .sub-tab-button');
                    if (first) first.click();
                    loadEmailTab();
                } else if (tabId === 'requests') {
                    loadPendingRegistrations();
                } else if (tabId === 'inventory') {
                    loadInventory();
                } else if (tabId === 'lost') {
                    loadLostKeysManagement();
                }
            });
        });

        document.querySelectorAll('.sub-tab-button').forEach(function(btn) {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.sub-tab-button').forEach(function(b) { b.classList.remove('active'); });
                this.classList.add('active');
                document.querySelectorAll('.sub-tab-panel').forEach(function(p) { p.classList.remove('active'); });
                var panel = document.getElementById('sub-' + this.dataset.subtab);
                if (panel) panel.classList.add('active');

                if (this.dataset.subtab === 'templates') loadTemplates();
                if (this.dataset.subtab === 'settings') loadSettings();
                if (this.dataset.subtab === 'admin-notifications') loadAdminRecipients();
            });
        });

        document.getElementById('refreshRequestsBtn') && document.getElementById('refreshRequestsBtn').addEventListener('click', loadPendingRegistrations);

        document.getElementById('transactionsRowsPerPage') && document.getElementById('transactionsRowsPerPage').addEventListener('change', function() {
            txRows = parseInt(this.value);
            txPage = 1;
            applyTransactionFilters();
        });

        document.getElementById('transactionsPrevPageBtn') && document.getElementById('transactionsPrevPageBtn').addEventListener('click', function() {
            if (txPage > 1) {
                txPage--;
                renderTransactionsTable();
                updateTransactionPagination();
            }
        });

        document.getElementById('transactionsNextPageBtn') && document.getElementById('transactionsNextPageBtn').addEventListener('click', function() {
            var totalPages = Math.ceil(txTotal / txRows);
            if (txPage < totalPages) {
                txPage++;
                renderTransactionsTable();
                updateTransactionPagination();
            }
        });

        document.getElementById('pendingRequestsCard') && document.getElementById('pendingRequestsCard').addEventListener('click', showPendingRequestsModal);
        document.getElementById('pendingKeyRequestsCard') && document.getElementById('pendingKeyRequestsCard').addEventListener('click', showPendingRequestsModal);
        document.getElementById('pendingReturnsCard') && document.getElementById('pendingReturnsCard').addEventListener('click', showPendingReturnsModal);
        document.getElementById('activeBorrowsCard') && document.getElementById('activeBorrowsCard').addEventListener('click', showActiveBorrowsModal);
        document.getElementById('returnRemindersCard') && document.getElementById('returnRemindersCard').addEventListener('click', showReturnRemindersModal);
        document.getElementById('lostKeysCard') && document.getElementById('lostKeysCard').addEventListener('click', showLostKeysModal);

        document.getElementById('refreshAuditBtn') && document.getElementById('refreshAuditBtn').addEventListener('click', loadAuditHealth);

        document.getElementById('modalConfirmBtn') && document.getElementById('modalConfirmBtn').addEventListener('click', async function() {
            var notes = document.getElementById('modalNotes').value.trim();
            var action = currentAction;
            var id = currentRequestId;
            var endpoint = action === 'approve' ? '/api/admin/requests/approve' : '/api/admin/requests/deny';

            try {
                var res = await authenticatedFetch(endpoint, {
                    method: 'POST',
                    body: { request_id: id, admin_notes: notes || null }
                });
                var data = await res.json();

                if (res.ok) {
                    showAlertModal(action === 'approve' ? 'Request approved.' : 'Request denied.', 'success');
                    document.getElementById('adminModal').style.display = 'none';
                    loadPendingRequests();
                    loadTransactions();
                    loadPendingReturns();
                } else {
                    showAlertModal(data.error || 'Action failed.', 'error');
                }
            } catch (err) {
                showAlertModal(err.message || 'Network error.', 'error');
            }
        });

        document.getElementById('modalCancelBtn') && document.getElementById('modalCancelBtn').addEventListener('click', function() {
            document.getElementById('adminModal').style.display = 'none';
        });
        document.getElementById('closeAdminModalBtn') && document.getElementById('closeAdminModalBtn').addEventListener('click', function() {
            document.getElementById('adminModal').style.display = 'none';
        });
        document.getElementById('adminModal') && document.getElementById('adminModal').addEventListener('click', function(e) {
            if (e.target === e.currentTarget) {
                document.getElementById('adminModal').style.display = 'none';
            }
        });

        document.getElementById('searchBtn') && document.getElementById('searchBtn').addEventListener('click', function(e) {
            e.preventDefault();
            loadTransactions();
        });

        document.getElementById('resetBtn') && document.getElementById('resetBtn').addEventListener('click', function(e) {
            e.preventDefault();
            document.getElementById('filterGiver').value = '';
            document.getElementById('filterReceiver').value = '';
            document.getElementById('filterBranch').value = '';
            document.getElementById('filterAction').value = '';
            document.getElementById('filterStatus').value = '';
            document.getElementById('filterFrom').value = '';
            document.getElementById('filterTo').value = '';
            txPage = 1;
            loadTransactions();
        });

        document.getElementById('inventorySearchInput') && document.getElementById('inventorySearchInput').addEventListener('input', function() {
            if (searchTimeout) clearTimeout(searchTimeout);
            searchTimeout = setTimeout(function() {
                invPage = 1;
                applyInventoryFilters();
            }, 300);
        });

        document.getElementById('inventoryResetFiltersBtn') && document.getElementById('inventoryResetFiltersBtn').addEventListener('click', function() {
            document.getElementById('inventorySearchInput').value = '';
            invPage = 1;
            applyInventoryFilters();
        });

        document.getElementById('inventoryPrevPageBtn') && document.getElementById('inventoryPrevPageBtn').addEventListener('click', function() {
            if (invPage > 1) {
                invPage--;
                renderInventoryTable();
                updateInventoryPagination();
            }
        });

        document.getElementById('inventoryNextPageBtn') && document.getElementById('inventoryNextPageBtn').addEventListener('click', function() {
            var totalPages = Math.ceil(invTotal / invRows);
            if (invPage < totalPages) {
                invPage++;
                renderInventoryTable();
                updateInventoryPagination();
            }
        });

        document.getElementById('refreshInventoryBtn') && document.getElementById('refreshInventoryBtn').addEventListener('click', loadInventory);

        document.getElementById('inventoryRowsPerPage') && document.getElementById('inventoryRowsPerPage').addEventListener('change', function() {
            invRows = parseInt(this.value);
            invPage = 1;
            applyInventoryFilters();
        });

        document.getElementById('manageKeysBtn') && document.getElementById('manageKeysBtn').addEventListener('click', openKeyManageModal);

        document.getElementById('closeKeyManageModalBtn') && document.getElementById('closeKeyManageModalBtn').addEventListener('click', function() {
            document.getElementById('keyManageModal').style.display = 'none';
        });
        document.getElementById('closeKeyManageFooterBtn') && document.getElementById('closeKeyManageFooterBtn').addEventListener('click', function() {
            document.getElementById('keyManageModal').style.display = 'none';
        });
        document.getElementById('keyManageModal') && document.getElementById('keyManageModal').addEventListener('click', function(e) {
            if (e.target === e.currentTarget) {
                document.getElementById('keyManageModal').style.display = 'none';
            }
        });

        document.getElementById('manageKeySearch') && document.getElementById('manageKeySearch').addEventListener('input', function() {
            manageKeyPage = 1;
            fetchManageKeys();
        });

        document.getElementById('resetManageKeyFilters') && document.getElementById('resetManageKeyFilters').addEventListener('click', function() {
            document.getElementById('manageKeySearch').value = '';
            manageKeyPage = 1;
            fetchManageKeys();
        });

        document.getElementById('manageKeyPrevBtn') && document.getElementById('manageKeyPrevBtn').addEventListener('click', function() {
            if (manageKeyPage > 1) {
                manageKeyPage--;
                renderManageKeyTable();
                updateManageKeyPagination();
            }
        });

        document.getElementById('manageKeyNextBtn') && document.getElementById('manageKeyNextBtn').addEventListener('click', function() {
            var totalPages = Math.ceil(manageKeyTotal / manageKeyRows);
            if (manageKeyPage < totalPages) {
                manageKeyPage++;
                renderManageKeyTable();
                updateManageKeyPagination();
            }
        });

        document.getElementById('addKeyFromManageBtn') && document.getElementById('addKeyFromManageBtn').addEventListener('click', function() {
            openKeyEditModal(null);
            document.getElementById('keyManageModal').style.display = 'none';
        });

        document.getElementById('closeKeyEditModalBtn') && document.getElementById('closeKeyEditModalBtn').addEventListener('click', function() {
            document.getElementById('keyEditModal').style.display = 'none';
        });
        document.getElementById('cancelKeyEditBtn') && document.getElementById('cancelKeyEditBtn').addEventListener('click', function() {
            document.getElementById('keyEditModal').style.display = 'none';
        });
        document.getElementById('keyEditModal') && document.getElementById('keyEditModal').addEventListener('click', function(e) {
            if (e.target === e.currentTarget) {
                document.getElementById('keyEditModal').style.display = 'none';
            }
        });

        document.getElementById('saveKeyEditBtn') && document.getElementById('saveKeyEditBtn').addEventListener('click', async function() {
            var id = document.getElementById('editKeyId').value;
            var code = document.getElementById('editKeyCode').value.trim();
            var brand = document.getElementById('editKeyBrand').value.trim();
            var ownerField = document.getElementById('editKeyOwner').value.trim();
            var totalQuantity = parseInt(document.getElementById('editKeySets').value) || 1;
            var dateOwned = document.getElementById('editKeyDateOwned').value;
            var remarks = document.getElementById('editKeyRemarks').value.trim();
            var status = document.getElementById('editKeyStatus').value;

            if (!code || !brand) {
                showAlertModal('Code and brand are required.', 'error');
                return;
            }

            if (status !== 'available' && status !== 'lost' && status !== 'unavailable') {
                showAlertModal('Invalid status. Cannot manually set to "borrowed".', 'error');
                return;
            }

            var sets = [];
            if (ownerField) {
                var owners = ownerField.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
                var quantityPerOwner = Math.max(1, Math.floor(totalQuantity / owners.length));
                for (var o = 0; o < owners.length; o++) {
                    sets.push({
                        owner_name: owners[o],
                        quantity: o === owners.length - 1 ? totalQuantity - (quantityPerOwner * (owners.length - 1)) : quantityPerOwner,
                        remarks: remarks || null
                    });
                }
            }

            var payload = {
                code: code,
                brand: brand,
                sets: sets,
                date_owned: dateOwned || null,
                remarks: remarks || null,
                status: status
            };

            var method = id ? 'PUT' : 'POST';
            var url = id ? '/api/admin/keys/' + id : '/api/admin/keys';

            try {
                var res = await authenticatedFetch(url, { method: method, body: payload });
                var data = await res.json();

                if (res.ok) {
                    showAlertModal(id ? 'Key updated successfully.' : 'Key created successfully.', 'success');
                    document.getElementById('keyEditModal').style.display = 'none';
                    loadInventory();
                    if (document.getElementById('keyManageModal').style.display === 'flex') fetchManageKeys();
                } else {
                    showAlertModal(data.error || 'Save failed.', 'error');
                }
            } catch (err) {
                showAlertModal(err.message || 'Network error.', 'error');
            }
        });

        document.addEventListener('click', function(e) {
            var btn = e.target.closest('.btn-print');
            if (!btn) return;
            var section = btn.dataset.section;
            var containerId = '';
            switch (section) {
                case 'transactions': containerId = 'transactionsCard'; break;
                case 'requests': containerId = 'requestsCard'; break;
                case 'inventory': containerId = 'inventoryCard'; break;
                case 'audit': containerId = 'auditCard'; break;
                case 'users': containerId = 'usersCard'; break;
                case 'templates': containerId = 'templatesCard'; break;
                case 'settings': containerId = 'settingsCard'; break;
                default: return;
            }
            printSection(containerId);
        });

        document.getElementById('manageTemplatesBtn') && document.getElementById('manageTemplatesBtn').addEventListener('click', openTemplateManageModal);
        document.getElementById('closeTemplateManageModalBtn') && document.getElementById('closeTemplateManageModalBtn').addEventListener('click', function() {
            document.getElementById('templateManageModal').style.display = 'none';
        });
        document.getElementById('closeTemplateManageFooterBtn') && document.getElementById('closeTemplateManageFooterBtn').addEventListener('click', function() {
            document.getElementById('templateManageModal').style.display = 'none';
        });
        document.getElementById('templateManageModal') && document.getElementById('templateManageModal').addEventListener('click', function(e) {
            if (e.target === e.currentTarget) {
                document.getElementById('templateManageModal').style.display = 'none';
            }
        });

        document.getElementById('addTemplateFromManageBtn') && document.getElementById('addTemplateFromManageBtn').addEventListener('click', function() {
            document.getElementById('editTemplateKey').value = '';
            document.getElementById('editTemplateKeyDisplay').value = '';
            document.getElementById('editTemplateKeyDisplay').disabled = false;
            document.getElementById('editTemplateKeyDisplay').placeholder = 'Enter a unique key (e.g., welcome)';
            document.getElementById('editTemplateSubject').value = '';
            document.getElementById('editTemplateBody').value = '';
            document.getElementById('editTemplateActive').checked = true;
            document.getElementById('templateEditModalTitle').textContent = 'Add New Template';
            document.getElementById('templateEditModal').style.display = 'flex';
        });

        document.getElementById('closeTemplateEditModalBtn') && document.getElementById('closeTemplateEditModalBtn').addEventListener('click', function() {
            document.getElementById('templateEditModal').style.display = 'none';
        });
        document.getElementById('cancelTemplateEditBtn') && document.getElementById('cancelTemplateEditBtn').addEventListener('click', function() {
            document.getElementById('templateEditModal').style.display = 'none';
        });
        document.getElementById('templateEditModal') && document.getElementById('templateEditModal').addEventListener('click', function(e) {
            if (e.target === e.currentTarget) {
                document.getElementById('templateEditModal').style.display = 'none';
            }
        });

        document.getElementById('saveTemplateEditBtn') && document.getElementById('saveTemplateEditBtn').addEventListener('click', async function() {
            var key = document.getElementById('editTemplateKey').value.trim();
            var keyDisplay = document.getElementById('editTemplateKeyDisplay').value.trim();
            var subject = document.getElementById('editTemplateSubject').value.trim();
            var body_html = document.getElementById('editTemplateBody').value.trim();
            var is_active = document.getElementById('editTemplateActive').checked;
            var finalKey = key || keyDisplay;

            if (!finalKey || !subject || !body_html) {
                showAlertModal('Key, subject, and body are required.', 'error');
                return;
            }

            var isNew = !key;
            var url = isNew ? '/api/admin/email/templates' : '/api/admin/email/templates/' + finalKey;
            var method = isNew ? 'POST' : 'PUT';

            try {
                var res = await authenticatedFetch(url, { method: method, body: { subject: subject, body_html: body_html, is_active: is_active } });

                if (res.ok) {
                    showAlertModal(isNew ? 'Template created successfully.' : 'Template updated successfully.', 'success');
                    document.getElementById('templateEditModal').style.display = 'none';
                    loadTemplates();
                    if (document.getElementById('templateManageModal').style.display === 'flex') openTemplateManageModal();
                } else {
                    var data = await res.json();
                    showAlertModal(data.error || 'Save failed.', 'error');
                }
            } catch (err) {
                showAlertModal(err.message || 'Network error.', 'error');
            }
        });

        document.getElementById('saveSettingsBtn') && document.getElementById('saveSettingsBtn').addEventListener('click', async function() {
            var toggles = document.querySelectorAll('.setting-toggle');
            var updates = [];

            for (var i = 0; i < toggles.length; i++) {
                var toggle = toggles[i];
                var key = toggle.dataset.key;
                var enabled = toggle.checked;
                var config = {};
                var configInputs = toggle.closest('.setting-control').querySelectorAll('[data-config]');

                for (var j = 0; j < configInputs.length; j++) {
                    var input = configInputs[j];
                    var configKey = input.dataset.config;
                    if (input.type === 'checkbox') {
                        config[configKey] = input.checked;
                    } else if (configKey === 'reminder_days_before') {
                        var val = input.value.trim();
                        config[configKey] = val ? val.split(',').map(function(s) { return parseInt(s.trim()); }).filter(function(n) { return !isNaN(n); }) : [];
                    } else {
                        config[configKey] = input.value;
                    }
                }
                updates.push({ key: key, enabled: enabled, config: config });
            }

            try {
                for (var u = 0; u < updates.length; u++) {
                    var update = updates[u];
                    await authenticatedFetch('/api/admin/email/settings/' + update.key, {
                        method: 'PUT',
                        body: { enabled: update.enabled, config: update.config }
                    });
                }
                showAlertModal('All settings saved successfully.', 'success');
                loadSettings();
            } catch (err) {
                showAlertModal(err.message || 'Failed to save settings.', 'error');
            }
        });

        document.getElementById('addAdminRecipientBtn') && document.getElementById('addAdminRecipientBtn').addEventListener('click', openAddAdminRecipientModal);
        document.getElementById('closeAddAdminRecipientModalBtn') && document.getElementById('closeAddAdminRecipientModalBtn').addEventListener('click', function() {
            document.getElementById('addAdminRecipientModal').style.display = 'none';
        });
        document.getElementById('cancelAddAdminRecipientBtn') && document.getElementById('cancelAddAdminRecipientBtn').addEventListener('click', function() {
            document.getElementById('addAdminRecipientModal').style.display = 'none';
        });
        document.getElementById('addAdminRecipientModal') && document.getElementById('addAdminRecipientModal').addEventListener('click', function(e) {
            if (e.target === e.currentTarget) {
                document.getElementById('addAdminRecipientModal').style.display = 'none';
            }
        });

        document.getElementById('saveAdminRecipientBtn') && document.getElementById('saveAdminRecipientBtn').addEventListener('click', async function() {
            var select = document.getElementById('adminRecipientSelect');
            var userId = parseInt(select.value);

            if (!userId) {
                showAlertModal('Please select an admin user.', 'error');
                return;
            }

            try {
                var res = await authenticatedFetch('/api/admin/admin-notification-recipients', {
                    method: 'POST',
                    body: { user_id: userId, enabled: true }
                });

                if (res.ok) {
                    showAlertModal('Admin added to notification recipients.', 'success');
                    document.getElementById('addAdminRecipientModal').style.display = 'none';
                    loadAdminRecipients();
                } else {
                    var data = await res.json();
                    showAlertModal(data.error || 'Failed to add recipient.', 'error');
                }
            } catch (err) {
                showAlertModal(err.message || 'Network error.', 'error');
            }
        });

        document.getElementById('refreshLostKeysBtn') && document.getElementById('refreshLostKeysBtn').addEventListener('click', loadLostKeysManagement);

        document.getElementById('closeLostKeyDetailModalBtn') && document.getElementById('closeLostKeyDetailModalBtn').addEventListener('click', function() {
            document.getElementById('lostKeyDetailModal').style.display = 'none';
        });
        document.getElementById('closeLostKeyDetailFooterBtn') && document.getElementById('closeLostKeyDetailFooterBtn').addEventListener('click', function() {
            document.getElementById('lostKeyDetailModal').style.display = 'none';
        });
        document.getElementById('lostKeyDetailModal') && document.getElementById('lostKeyDetailModal').addEventListener('click', function(e) {
            if (e.target === e.currentTarget) {
                document.getElementById('lostKeyDetailModal').style.display = 'none';
            }
        });

        document.getElementById('closeLostKeyEditModalBtn') && document.getElementById('closeLostKeyEditModalBtn').addEventListener('click', function() {
            document.getElementById('lostKeyEditModal').style.display = 'none';
        });
        document.getElementById('cancelLostKeyEditBtn') && document.getElementById('cancelLostKeyEditBtn').addEventListener('click', function() {
            document.getElementById('lostKeyEditModal').style.display = 'none';
        });
        document.getElementById('lostKeyEditModal') && document.getElementById('lostKeyEditModal').addEventListener('click', function(e) {
            if (e.target === e.currentTarget) {
                document.getElementById('lostKeyEditModal').style.display = 'none';
            }
        });

        document.getElementById('saveLostKeyEditBtn') && document.getElementById('saveLostKeyEditBtn').addEventListener('click', async function() {
            var id = document.getElementById('editLostTransactionId').value;
            var reason = document.getElementById('editLostReason').value.trim();
            var lostAt = document.getElementById('editLostDate').value;
            var status = document.getElementById('editLostStatus').value;

            if (!reason) {
                showAlertModal('Reason for loss is required.', 'error');
                return;
            }

            try {
                var res = await authenticatedFetch('/api/admin/lost-keys/' + id + '/update', {
                    method: 'POST',
                    body: {
                        reason: reason,
                        lost_at: lostAt || null,
                        status: status
                    }
                });

                if (res.ok) {
                    showAlertModal('Lost key updated successfully.', 'success');
                    document.getElementById('lostKeyEditModal').style.display = 'none';
                    loadLostKeysManagement();
                    loadLostKeys();
                } else {
                    var data = await res.json();
                    showAlertModal(data.error || 'Update failed.', 'error');
                }
            } catch (err) {
                showAlertModal(err.message || 'Network error.', 'error');
            }
        });

        document.getElementById('refreshAdminRecipientsBtn') && document.getElementById('refreshAdminRecipientsBtn').addEventListener('click', loadAdminRecipients);
        document.getElementById('refreshAuditLogBtn') && document.getElementById('refreshAuditLogBtn').addEventListener('click', function() {
            var originalHtml = this.innerHTML;
            this.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            this.disabled = true;

            loadAuditLogs().finally(function() {
                refreshAuditLogBtn.innerHTML = originalHtml;
                refreshAuditLogBtn.disabled = false;
            });
        });

        document.getElementById('addRoleBtn') && document.getElementById('addRoleBtn').addEventListener('click', function() {
            document.getElementById('newRoleName').value = '';
            document.getElementById('addRoleModal').style.display = 'flex';
        });

        document.getElementById('closeAddRoleModalBtn') && document.getElementById('closeAddRoleModalBtn').addEventListener('click', function() {
            document.getElementById('addRoleModal').style.display = 'none';
        });
        document.getElementById('cancelAddRoleBtn') && document.getElementById('cancelAddRoleBtn').addEventListener('click', function() {
            document.getElementById('addRoleModal').style.display = 'none';
        });
        document.getElementById('addRoleModal') && document.getElementById('addRoleModal').addEventListener('click', function(e) {
            if (e.target === e.currentTarget) {
                document.getElementById('addRoleModal').style.display = 'none';
            }
        });

        document.getElementById('confirmAddRoleBtn') && document.getElementById('confirmAddRoleBtn').addEventListener('click', function() {
            var name = document.getElementById('newRoleName').value.trim();
            if (!name) {
                showAlertModal('Please enter a role name.', 'error');
                return;
            }
            if (permissionsData.roleMappings[name]) {
                showAlertModal('Role already exists.', 'error');
                return;
            }
            permissionsData.roleMappings[name] = [];
            permissionsData.roles = [];
            for (var key in permissionsData.roleMappings) {
                if (permissionsData.roleMappings.hasOwnProperty(key)) {
                    permissionsData.roles.push(key);
                }
            }
            renderPermissions();
            document.getElementById('addRoleModal').style.display = 'none';
            showAlertModal('Role "' + name + '" added.', 'success');
        });

        document.getElementById('savePermissionsBtn') && document.getElementById('savePermissionsBtn').addEventListener('click', async function() {
            var updates = {};
            document.querySelectorAll('.permission-checkbox').forEach(function(cb) {
                var role = cb.dataset.role;
                var permId = parseInt(cb.dataset.permId);
                if (!updates[role]) updates[role] = [];
                if (cb.checked) updates[role].push(permId);
            });

            try {
                for (var roleName in updates) {
                    if (updates.hasOwnProperty(roleName)) {
                        await authenticatedFetch('/api/permissions/roles', {
                            method: 'POST',
                            body: { role_name: roleName, permission_ids: updates[roleName] }
                        });
                    }
                }
                showAlertModal('Permissions saved successfully.', 'success');
                await loadPermissions();
            } catch (err) {
                showAlertModal(err.message || 'Failed to save permissions.', 'error');
            }
        });

        document.getElementById('closeKeyDetailModalBtn') && document.getElementById('closeKeyDetailModalBtn').addEventListener('click', function() {
            document.getElementById('keyDetailModal').style.display = 'none';
        });
        document.getElementById('closeKeyDetailFooterBtn') && document.getElementById('closeKeyDetailFooterBtn').addEventListener('click', function() {
            document.getElementById('keyDetailModal').style.display = 'none';
        });
        document.getElementById('keyDetailModal') && document.getElementById('keyDetailModal').addEventListener('click', function(e) {
            if (e.target === e.currentTarget) {
                document.getElementById('keyDetailModal').style.display = 'none';
            }
        });

        document.getElementById('openUserManagementBtn') && document.getElementById('openUserManagementBtn').addEventListener('click', function() {
            document.getElementById('userManagementModal').style.display = 'flex';
            fetchManageUsers();
        });

        document.getElementById('closeUserManagementModalBtn') && document.getElementById('closeUserManagementModalBtn').addEventListener('click', function() {
            document.getElementById('userManagementModal').style.display = 'none';
        });
        document.getElementById('userManagementModal') && document.getElementById('userManagementModal').addEventListener('click', function(e) {
            if (e.target === e.currentTarget) {
                document.getElementById('userManagementModal').style.display = 'none';
            }
        });
    }

    // ==================== REFRESH INTERVAL ====================
    function startRefreshInterval() {
        if (refreshInterval) clearInterval(refreshInterval);
        refreshInterval = setInterval(function() {
            if (isPageVisible) {
                loadPendingRequests();
                loadTransactions();
                loadPendingReturns();
                loadLostKeys();
                loadAuditHealth();
            }
        }, 60000);
    }

    // ==================== INIT ====================
    async function init() {
        var isAuthenticated = await checkAuth();
        if (!isAuthenticated) return;

        var loadingContainer = document.getElementById('loadingContainer');
        var adminContentWrapper = document.getElementById('adminContentWrapper');

        if (loadingContainer) loadingContainer.style.display = 'none';
        if (adminContentWrapper) adminContentWrapper.style.display = 'block';

        await ensureCsrfToken();
        initEventListeners();
        initUserManagement();

        await loadPendingRequests();
        await loadTransactions();
        await loadPendingReturns();

        setTimeout(function() {
            loadLostKeys();
            loadAuditHealth();
            loadPendingRegistrations();
            checkEmailPermissions();
        }, 500);

        document.addEventListener('visibilitychange', function() {
            isPageVisible = !document.hidden;
            if (isPageVisible) {
                loadPendingRequests();
                loadTransactions();
                loadPendingReturns();
                loadLostKeys();
                loadAuditHealth();
                if (refreshInterval) {
                    clearInterval(refreshInterval);
                    refreshInterval = null;
                }
                startRefreshInterval();
            } else {
                if (refreshInterval) {
                    clearInterval(refreshInterval);
                    refreshInterval = null;
                }
            }
        });

        startRefreshInterval();
    }

    document.addEventListener('DOMContentLoaded', init);
})();