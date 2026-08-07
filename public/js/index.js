(function() {
    'use strict';

    let isRedirecting = false;

    if (!localStorage.getItem('kms_token') && !window.location.pathname.includes('/login')) {
        window.location.href = '/login';
        return;
    }

    let allKeys = [];
    let basket = [];
    let currentBrandFilter = 'all';
    let currentLoanFilter = 'all';
    let pollInterval = null;
    let activePopover = null;
    let notificationTimeout = null;
    let pendingLostTransaction = null;

    // ============================================================
    // AUTH & UTILITY FUNCTIONS
    // ============================================================

    function redirectToLogin() {
        if (isRedirecting) return;
        isRedirecting = true;
        localStorage.removeItem('kms_token');
        localStorage.removeItem('kms_user');
        sessionStorage.clear();
        document.cookie.split(";").forEach(function(c) {
            document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
        });
        window.location.href = '/login?t=' + Date.now();
    }

    function getToken() {
        return localStorage.getItem('kms_token');
    }

    function getUser() {
        try { return JSON.parse(localStorage.getItem('kms_user')); } catch { return null; }
    }

    function getUserEmail() {
        const user = getUser();
        return user?.email || '';
    }

    function getUserName() {
        const user = getUser();
        return user?.name || '';
    }

    function getRole() {
        const u = getUser();
        return u?.role || 'user';
    }

    function isAdmin() {
        return getRole() === 'admin';
    }

    function getInitials(name) {
        if (!name) return '?';
        const parts = name.trim().split(/\s+/);
        if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
        return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }

    function generateRequestId() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0,
                v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : m === '>' ? '&gt;' : '');
    }

    function formatDate(isoString) {
        if (!isoString) return '—';
        const d = new Date(isoString);
        return d.toLocaleString('en-SG', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function getDotColour(colour) {
        const map = {
            orange: '#F97316',
            red: '#EF4444',
            blue: '#3B82F6',
            purple: '#8B5CF6',
            pink: '#EC4899',
            yellow: '#EAB308',
            'tiffany blue': '#14B8A6',
            green: '#22C55E',
            black: '#1E293B',
            white: '#F8FAFC'
        };
        return map[colour?.toLowerCase()] || '#94A3B8';
    }

    function isLightColor(hexColor) {
        const hex = hexColor.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
    }

    function getReturnStatus(plannedReturnISO) {
        if (!plannedReturnISO) return { text: 'No return date', urgencyClass: '' };
        const now = new Date(),
            due = new Date(plannedReturnISO),
            diff = due - now;
        if (diff < 0) {
            const days = Math.abs(Math.floor(diff / (1000 * 60 * 60 * 24)));
            return { text: `Overdue by ${days} day${days !== 1 ? 's' : ''}`, urgencyClass: 'return-overdue' };
        }
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        if (days > 1) return { text: `Due in ${days} days`, urgencyClass: '' };
        if (days === 1) return { text: 'Due tomorrow', urgencyClass: 'return-urgent' };
        const hours = Math.floor(diff / (1000 * 60 * 60));
        return { text: `Due in ${hours} hour${hours !== 1 ? 's' : ''}`, urgencyClass: 'return-urgent' };
    }

    function showToast(message, type) {
        type = type || 'success';
        let toastRoot = document.getElementById('toastRoot');
        if (!toastRoot) {
            toastRoot = document.createElement('div');
            toastRoot.id = 'toastRoot';
            document.body.appendChild(toastRoot);
        }
        const toast = document.createElement('div');
        toast.className = 'toast-notification';
        toast.textContent = message;
        if (type === 'error') toast.style.background = '#EF4444';
        else if (type === 'warning') toast.style.background = '#F59E0B';
        else toast.style.background = '#1E293B';
        toastRoot.appendChild(toast);
        setTimeout(function() { toast.remove(); }, 3000);
    }

    function showNotification(title, message, type) {
        type = type || 'success';
        const modal = document.getElementById('notificationModal');
        if (!modal) return;
        const iconDiv = document.getElementById('notificationIcon');
        const titleSpan = document.getElementById('notificationTitle');
        const messageSpan = document.getElementById('notificationMessage');

        iconDiv.className = 'notification-icon ' + type;
        let iconSvg = '';
        if (type === 'success') {
            iconSvg = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />';
        } else if (type === 'warning') {
            iconSvg = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />';
        } else if (type === 'error') {
            iconSvg = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />';
        } else {
            iconSvg = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />';
        }
        iconDiv.innerHTML = '<svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">' + iconSvg + '</svg>';
        titleSpan.innerText = title;
        messageSpan.innerText = message;
        modal.style.display = 'flex';
        if (notificationTimeout) clearTimeout(notificationTimeout);
        notificationTimeout = setTimeout(function() { closeNotification(); }, 3000);
    }

    function closeNotification() {
        const modal = document.getElementById('notificationModal');
        if (modal) modal.style.display = 'none';
        if (notificationTimeout) clearTimeout(notificationTimeout);
    }

    function createPopover(borrower, returnDateISO) {
        const info = getReturnStatus(returnDateISO);
        const pop = document.createElement('div');
        pop.className = 'popover';
        pop.innerHTML = '<div><span class="font-semibold text-slate-800">' + escapeHtml(borrower) + '</span></div><hr class="my-2"><div class="text-slate-600">Expected return: <span class="' + info.urgencyClass + '">' + info.text + '</span></div>';
        return pop;
    }

    function showPopover(target, borrower, returnDate) {
        if (activePopover) activePopover.remove();
        const pop = createPopover(borrower, returnDate);
        document.body.appendChild(pop);
        const rect = target.getBoundingClientRect();
        pop.style.top = (rect.bottom + window.scrollY + 6) + 'px';
        pop.style.left = (rect.left + window.scrollX + rect.width / 2 - 100) + 'px';
        pop.classList.add('show');
        activePopover = pop;
    }

    function hidePopover() {
        if (activePopover) {
            activePopover.remove();
            activePopover = null;
        }
    }

    // ============================================================
    // AUTHENTICATED FETCH
    // ============================================================

    async function authenticatedFetch(url, options) {
        options = options || {};
        const token = getToken();
        if (!token) {
            if (!isRedirecting) redirectToLogin();
            throw new Error('No token');
        }

        const csrf = await getCsrfToken();

        const headers = {
            'Authorization': 'Bearer ' + token,
            'X-CSRF-Token': csrf || '',
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json',
            'X-Request-Id': generateRequestId(),
            ...options.headers
        };

        if (options.body && !(options.body instanceof FormData)) {
            headers['Content-Type'] = 'application/json';
        }
        if (options.body instanceof FormData) {
            delete headers['Content-Type'];
        }

        const fetchOptions = { ...options, headers, credentials: 'include' };
        if (options.method === 'GET') delete fetchOptions.body;

        try {
            let response = await fetch(url, fetchOptions);

            if (response.status === 403) {
                const errorData = await response.json().catch(function() { return {}; });
                if (errorData.error === 'Invalid CSRF token' || errorData.code === 'INVALID_CSRF') {
                    const newCsrf = await refreshCsrfToken();
                    if (newCsrf) {
                        headers['X-CSRF-Token'] = newCsrf;
                        const retryOptions = { ...fetchOptions, headers };
                        response = await fetch(url, retryOptions);
                    }
                }
            }

            if (response.status === 401) {
                if (!isRedirecting) redirectToLogin();
                throw new Error('Session expired');
            }

            return response;
        } catch (error) {
            if (error.name === 'TypeError' && error.message.indexOf('fetch') !== -1) {
                throw new Error('Network error. Please check your connection.');
            }
            throw error;
        }
    }

    // ============================================================
    // AUTH CHECK - FIXED: Ensures user data is properly loaded
    // ============================================================

    async function checkAuth() {
        try {
            const token = getToken();
            if (!token) {
                if (!isRedirecting) redirectToLogin();
                return false;
            }

            const response = await fetch('/api/auth/check-session', {
                credentials: 'include',
                headers: { 'Accept': 'application/json' }
            });

            if (!response.ok) {
                if (!isRedirecting) redirectToLogin();
                return false;
            }

            const data = await response.json();
            if (!data.authenticated) {
                if (!isRedirecting) redirectToLogin();
                return false;
            }

            // FIX: Ensure user has name and email from profile
            if (data.user) {
                try {
                    const profileRes = await fetch('/api/user/profile', {
                        credentials: 'include',
                        headers: {
                            'Authorization': 'Bearer ' + token,
                            'Accept': 'application/json'
                        }
                    });
                    if (profileRes.ok) {
                        const profileData = await profileRes.json();
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

            return true;
        } catch (error) {
            console.error('Auth check failed:', error);
            if (!isRedirecting) redirectToLogin();
            return false;
        }
    }

    async function handleLogout() {
        if (isRedirecting) return;
        isRedirecting = true;
        try {
            const token = getToken();
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

    // ============================================================
    // PROFILE - FIXED: Persists name and email
    // ============================================================

    function openProfileModal() {
        const modal = document.getElementById('profileModal');
        if (modal) {
            const user = getUser();
            if (user) {
                document.getElementById('profileName').value = user.name || '';
                document.getElementById('profileEmail').value = user.email || '';
            }
            document.getElementById('profileCurrentPassword').value = '';
            document.getElementById('profileNewPassword').value = '';
            document.getElementById('profileError').style.display = 'none';
            document.getElementById('profileSuccess').style.display = 'none';
            modal.style.display = 'flex';
        }
    }

    async function saveProfile() {
        const name = document.getElementById('profileName').value.trim();
        const email = document.getElementById('profileEmail').value.trim();
        const currentPassword = document.getElementById('profileCurrentPassword').value;
        const newPassword = document.getElementById('profileNewPassword').value;
        const errorDiv = document.getElementById('profileError');
        const successDiv = document.getElementById('profileSuccess');
        const btn = document.getElementById('saveProfileBtn');

        errorDiv.style.display = 'none';
        successDiv.style.display = 'none';

        if (!name || !email || !email.includes('@') || !email.includes('.')) {
            errorDiv.textContent = !name || !email ? 'Name and email are required.' : 'Please enter a valid email address.';
            errorDiv.style.display = 'block';
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Saving...';

        try {
            const payload = { name: name, email: email };
            if (newPassword) {
                if (!currentPassword) {
                    errorDiv.textContent = 'Current password is required to change password.';
                    errorDiv.style.display = 'block';
                    btn.disabled = false;
                    btn.textContent = 'Save Changes';
                    return;
                }
                payload.current_password = currentPassword;
                payload.new_password = newPassword;
            }

            const res = await authenticatedFetch('/api/user/profile', {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
            const data = await res.json();

            if (res.ok) {
                const user = getUser();
                if (user) {
                    user.name = name;
                    user.email = email;
                    localStorage.setItem('kms_user', JSON.stringify(user));
                }
                successDiv.textContent = 'Profile updated successfully!';
                successDiv.style.display = 'block';
                document.getElementById('profileCurrentPassword').value = '';
                document.getElementById('profileNewPassword').value = '';
                // FIX: Refresh page to ensure all components use updated user data
                setTimeout(function() {
                    document.getElementById('profileModal').style.display = 'none';
                    window.location.reload();
                }, 1500);
            } else {
                errorDiv.textContent = data.error || 'Failed to update profile.';
                errorDiv.style.display = 'block';
            }
        } catch (err) {
            errorDiv.textContent = err.message || 'Network error. Please try again.';
            errorDiv.style.display = 'block';
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Changes';
        }
    }

    // ============================================================
    // BORROW TOGGLE
    // ============================================================

    function initBorrowToggle() {
        const toggleBtns = document.querySelectorAll('.borrow-toggle-btn');
        const timeContainer = document.getElementById('borrowTimeContainer');
        const borrowDateHidden = document.getElementById('borrowDateHidden');
        const timePicker = document.getElementById('borrowTimePicker');
        const plannedReturn = document.getElementById('modalPlannedReturn');

        if (!toggleBtns.length) return;

        const now = new Date();
        if (borrowDateHidden) borrowDateHidden.value = now.toISOString();
        if (plannedReturn) {
            const returnDate = new Date(now);
            returnDate.setDate(returnDate.getDate() + 7);
            plannedReturn.value = returnDate.toISOString().slice(0, 16);
        }

        toggleBtns.forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                toggleBtns.forEach(function(b) { b.classList.remove('active'); });
                this.classList.add('active');

                const borrowType = this.dataset.borrowType;
                if (borrowType === 'now') {
                    const now = new Date();
                    if (borrowDateHidden) borrowDateHidden.value = now.toISOString();
                    if (timeContainer) timeContainer.style.display = 'none';
                    if (plannedReturn) {
                        const returnDate = new Date(now);
                        returnDate.setDate(returnDate.getDate() + 7);
                        plannedReturn.value = returnDate.toISOString().slice(0, 16);
                    }
                } else if (borrowType === 'today') {
                    if (timeContainer) timeContainer.style.display = 'block';
                    if (timePicker) {
                        const now = new Date();
                        const hours = String(now.getHours()).padStart(2, '0');
                        const minutes = String(now.getMinutes()).padStart(2, '0');
                        timePicker.value = hours + ':' + minutes;
                        updateBorrowDateTime();
                    }
                }
            });
        });

        if (timePicker) {
            timePicker.addEventListener('change', updateBorrowDateTime);
            timePicker.addEventListener('input', updateBorrowDateTime);
        }

        function updateBorrowDateTime() {
            const timePicker = document.getElementById('borrowTimePicker');
            const borrowDateHidden = document.getElementById('borrowDateHidden');
            const plannedReturn = document.getElementById('modalPlannedReturn');
            if (timePicker && borrowDateHidden) {
                const now = new Date();
                const parts = timePicker.value.split(':').map(Number);
                now.setHours(parts[0] || 0, parts[1] || 0, 0, 0);
                borrowDateHidden.value = now.toISOString();
                if (plannedReturn) {
                    const returnDate = new Date(now);
                    returnDate.setDate(returnDate.getDate() + 7);
                    plannedReturn.value = returnDate.toISOString().slice(0, 16);
                }
            }
        }
    }

    // ============================================================
    // EVENT LISTENERS
    // ============================================================

    function initEventListeners() {
        document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);
        document.getElementById('mobileLogoutBtn')?.addEventListener('click', handleLogout);

        const mobileMenuBtn = document.getElementById('mobileMenuBtn');
        const mobileMenu = document.getElementById('mobileMenu');
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

        document.getElementById('mobileProfileBtn')?.addEventListener('click', function() {
            const mobileMenu = document.getElementById('mobileMenu');
            if (mobileMenu) mobileMenu.classList.remove('open');
            openProfileModal();
        });

        document.getElementById('myProfileBtn')?.addEventListener('click', openProfileModal);

        document.getElementById('closeProfileModalBtn')?.addEventListener('click', function() {
            document.getElementById('profileModal').style.display = 'none';
        });
        document.getElementById('cancelProfileBtn')?.addEventListener('click', function() {
            document.getElementById('profileModal').style.display = 'none';
        });
        document.getElementById('profileModal')?.addEventListener('click', function(e) {
            if (e.target === document.getElementById('profileModal')) {
                document.getElementById('profileModal').style.display = 'none';
            }
        });

        document.getElementById('saveProfileBtn')?.addEventListener('click', saveProfile);

        document.getElementById('closeNotificationBtn')?.addEventListener('click', closeNotification);
        document.getElementById('notificationModal')?.addEventListener('click', function(e) {
            if (e.target === document.getElementById('notificationModal')) closeNotification();
        });

        document.addEventListener('click', function(e) {
            if (activePopover && !activePopover.contains(e.target) && !e.target.closest('.key-card .badge')) {
                hidePopover();
            }
        });

        document.getElementById('clearBasketBtn')?.addEventListener('click', function() {
            if (basket.length) {
                basket = [];
                renderBasket();
                showToast('Basket cleared', 'info');
            }
        });

        document.getElementById('submitRequestBtn')?.addEventListener('click', openRequestModal);
        document.getElementById('closeModalBtn')?.addEventListener('click', closeRequestModal);
        document.getElementById('cancelModalBtn')?.addEventListener('click', closeRequestModal);
        document.getElementById('confirmSubmitBtn')?.addEventListener('click', submitRequest);
        document.getElementById('consentCheckbox')?.addEventListener('change', function() {
            const confirmBtn = document.getElementById('confirmSubmitBtn');
            if (confirmBtn) {
                confirmBtn.disabled = !document.getElementById('consentCheckbox').checked;
            }
        });

        const searchInput = document.getElementById('globalSearch');
        searchInput?.addEventListener('input', filterKeysBySearch);

        initBorrowToggle();
    }

    // ============================================================
    // KEYS
    // ============================================================

    async function fetchKeys() {
        try {
            const res = await authenticatedFetch('/api/keys?_=' + Date.now(), {
                cache: 'no-store',
                headers: { 'Cache-Control': 'no-cache' }
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            allKeys = await res.json();
            renderFilteredGrid();
            const indicator = document.getElementById('onlineIndicator');
            const status = document.getElementById('onlineStatus');
            if (indicator) {
                indicator.classList.remove('bg-red-500');
                indicator.classList.add('online');
            }
            if (status) status.textContent = 'Online';
        } catch (e) {
            console.error('Fetch keys error:', e);
            const indicator = document.getElementById('onlineIndicator');
            const status = document.getElementById('onlineStatus');
            if (indicator) {
                indicator.classList.remove('online');
                indicator.classList.add('bg-red-500');
            }
            if (status) status.textContent = 'Offline';
            if (!allKeys.length) {
                const grid = document.getElementById('keysGrid');
                if (grid) {
                    grid.innerHTML = '<div class="col-span-full text-center py-12 text-slate-400">Error loading keys. Please refresh.</div>';
                }
                showToast('Failed to load keys', 'error');
            }
        }
    }

    function renderFilteredGrid() {
        let filtered = [...allKeys];
        if (currentBrandFilter !== 'all') filtered = filtered.filter(function(k) { return k.brand === currentBrandFilter; });
        if (currentLoanFilter === 'available') filtered = filtered.filter(function(k) { return k.available === true; });
        else if (currentLoanFilter === 'loaned') filtered = filtered.filter(function(k) { return k.available === false; });

        const container = document.getElementById('keysGrid');
        const emptyState = document.getElementById('emptySearchState');

        if (!filtered.length) {
            if (container) {
                container.innerHTML = '<div class="col-span-full text-center py-12 text-slate-400">No keys match current filters.</div>';
            }
            if (emptyState) emptyState.classList.add('hidden');
            return;
        }

        let html = '';
        filtered.forEach(function(key) {
            const dotColor = getDotColour(key.colour);
            let statusBadge = '';
            const keyStatus = key.status || (key.is_lost ? 'lost' : 'available');

            if (keyStatus === 'lost') {
                statusBadge = '<span class="key-status" style="background:rgba(220,38,38,0.85);">Lost</span>';
            } else if (keyStatus === 'unavailable') {
                statusBadge = '<span class="key-status" style="background:rgba(100,116,139,0.85);">Unavailable</span>';
            } else if (key.pending) {
                statusBadge = '<span class="key-status" style="background:rgba(245,158,11,0.85);">Pending</span>';
            } else if (key.pending_return) {
                statusBadge = '<span class="key-status" style="background:rgba(245,158,11,0.85);">Returning</span>';
            } else if (key.available) {
                statusBadge = '<span class="key-status" style="background:rgba(16,185,129,0.85);">Available</span>';
            } else {
                statusBadge = '<span class="key-status" style="background:rgba(100,116,139,0.85);">On Loan</span>';
            }

            const isLight = isLightColor(dotColor);
            const textColor = isLight ? '#0f172a' : '#ffffff';
            const shadow = isLight ? '0 1px 4px rgba(0,0,0,0.1)' : '0 1px 4px rgba(0,0,0,0.3)';

            html += '<div class="key-card" style="background-color:' + dotColor + '; color:' + textColor + '; text-shadow:' + shadow + ';"'
                + ' data-id="' + key.id + '" data-code="' + escapeHtml(key.code) + '" data-brand="' + escapeHtml(key.brand) + '"'
                + ' data-available="' + key.available + '" data-status="' + keyStatus + '"'
                + ' data-borrower-name="' + escapeHtml(key.borrower_name || '') + '"'
                + ' data-borrower-email="' + escapeHtml(key.borrower_email || '') + '"'
                + ' data-return-date="' + (key.planned_return || '') + '">'
                + '<div class="key-code">' + escapeHtml(key.code) + '</div>'
                + '<div class="key-brand">' + escapeHtml(key.brand) + '</div>'
                + statusBadge
                + '</div>';
        });
        if (container) {
            container.innerHTML = html;
        }

        document.querySelectorAll('.key-card').forEach(function(card) {
            card.addEventListener('click', function(e) {
                if (e.target.closest('.key-status') || e.target.closest('.popover')) return;
                const keyId = parseInt(this.dataset.id);
                const key = allKeys.find(function(k) { return k.id === keyId; });
                if (key && key.available && key.status !== 'lost' && key.status !== 'unavailable') {
                    addToBasket(key);
                } else if (key) {
                    const status = key.status || (key.is_lost ? 'lost' : 'unavailable');
                    if (status === 'lost') {
                        showToast(key.code + ' is marked as lost', 'warning');
                    } else if (status === 'unavailable') {
                        showToast(key.code + ' is unavailable', 'warning');
                    } else {
                        showToast(key.code + ' is not available for borrowing', 'warning');
                    }
                }
            });
        });

        document.querySelectorAll('.key-card .key-status').forEach(function(badge) {
            const card = badge.closest('.key-card');
            if (!card) return;
            const isAvailable = card.getAttribute('data-available') === 'true';
            if (isAvailable) return;
            badge.addEventListener('click', function(e) {
                e.stopPropagation();
                const borrowerName = card.getAttribute('data-borrower-name');
                const returnDate = card.getAttribute('data-return-date');
                if (borrowerName && returnDate && borrowerName !== '') {
                    showPopover(this, borrowerName, returnDate);
                }
            });
        });

        filterKeysBySearch();
    }

    function filterKeysBySearch() {
        const searchInput = document.getElementById('globalSearch');
        const emptyState = document.getElementById('emptySearchState');
        const query = (searchInput?.value.trim().toLowerCase()) || '';
        const cards = document.querySelectorAll('#keysGrid .key-card');
        let visibleCount = 0;
        cards.forEach(function(card) {
            const keyCode = (card.getAttribute('data-code') || '').toLowerCase();
            const borrowerEmail = (card.getAttribute('data-borrower-email') || '').toLowerCase();
            const matches = query === '' || keyCode.indexOf(query) !== -1 || borrowerEmail.indexOf(query) !== -1;
            if (matches) {
                card.classList.remove('filter-hidden');
                visibleCount++;
            } else {
                card.classList.add('filter-hidden');
            }
        });
        if (emptyState) {
            if (visibleCount === 0 && query !== '') emptyState.classList.remove('hidden');
            else emptyState.classList.add('hidden');
        }
    }

    // ============================================================
    // BASKET
    // ============================================================

    function addToBasket(key) {
        if (!key.available || key.status === 'lost' || key.status === 'unavailable') {
            showToast(key.code + ' is not available', 'warning');
            return;
        }
        if (basket.some(function(k) { return k.id === key.id; })) {
            showToast(key.code + ' already in basket', 'warning');
            return;
        }
        basket.push({ id: key.id, code: key.code, brand: key.brand });
        renderBasket();
        const card = document.querySelector('.key-card[data-id="' + key.id + '"]');
        if (card) {
            card.classList.add('ring-2', 'ring-blue-400', 'ring-offset-1');
            setTimeout(function() { card.classList.remove('ring-2', 'ring-blue-400', 'ring-offset-1'); }, 400);
        }
        showToast(key.code + ' added to basket', 'success');
    }

    function removeFromBasket(keyId) {
        const removed = basket.find(function(k) { return k.id === keyId; });
        if (removed) {
            basket = basket.filter(function(k) { return k.id !== keyId; });
            renderBasket();
            showToast(removed.code + ' removed', 'info');
        }
    }

    function renderBasket() {
        const container = document.getElementById('basketItemsContainer');
        const countSpan = document.getElementById('basketCountBadge');
        const totalSpan = document.getElementById('totalQuantity');
        const submitBtn = document.getElementById('submitRequestBtn');
        const total = basket.length;

        if (countSpan) countSpan.innerText = total;
        if (totalSpan) totalSpan.innerText = total;

        if (total === 0) {
            if (container) {
                container.innerHTML = '<div class="p-6 text-center text-slate-400 text-sm">No keys selected. Click on available keys to add.</div>';
            }
            if (submitBtn) submitBtn.disabled = true;
            return;
        }

        if (submitBtn) submitBtn.disabled = false;
        let html = '<div class="divide-y divide-gray-100">';
        basket.forEach(function(item) {
            html += '<div class="flex justify-between items-center p-3 hover:bg-slate-50 transition">'
                + '<div><span class="font-medium text-slate-800">' + escapeHtml(item.code) + '</span>'
                + '<span class="text-xs text-slate-500 ml-1.5">' + escapeHtml(item.brand) + '</span></div>'
                + '<button class="remove-item text-rose-500 hover:text-rose-700 transition text-sm font-medium" data-id="' + item.id + '">Remove</button>'
                + '</div>';
        });
        html += '</div>';
        if (container) {
            container.innerHTML = html;
        }

        document.querySelectorAll('.remove-item').forEach(function(btn) {
            btn.addEventListener('click', function() {
                removeFromBasket(parseInt(btn.dataset.id));
            });
        });
    }

    // ============================================================
    // REQUEST MODAL
    // ============================================================

    function openRequestModal() {
        if (!basket.length) {
            showNotification('Empty Basket', 'Please add at least one key to your basket before submitting a request.', 'warning');
            return;
        }

        const listContainer = document.getElementById('modalSelectedKeysList');
        if (listContainer) {
            listContainer.innerHTML = '<ul class="list-disc list-inside">' + basket.map(function(i) { return '<li>' + escapeHtml(i.code) + ' (' + escapeHtml(i.brand) + ')</li>'; }).join('') + '</ul>';
        }

        const user = getUser();
        const nameDisplay = document.getElementById('modalUserDisplayName');
        const emailDisplay = document.getElementById('modalUserDisplayEmail');
        if (nameDisplay) nameDisplay.textContent = user?.name || 'Not logged in';
        if (emailDisplay) emailDisplay.textContent = user?.email || 'Not logged in';

        document.getElementById('modalReason').value = '';
        const plannedReturn = document.getElementById('modalPlannedReturn');
        if (plannedReturn) {
            const now = new Date();
            const returnDate = new Date(now);
            returnDate.setDate(returnDate.getDate() + 7);
            plannedReturn.value = returnDate.toISOString().slice(0, 16);
        }
        const errorDiv = document.getElementById('modalError');
        if (errorDiv) errorDiv.classList.add('hidden');
        document.getElementById('consentCheckbox').checked = false;
        document.getElementById('confirmSubmitBtn').disabled = true;
        document.getElementById('requestModal').style.display = 'flex';
    }

    function closeRequestModal() {
        document.getElementById('requestModal').style.display = 'none';
    }

    async function submitRequest() {
        const user = getUser();
        const name = user?.name || '';
        const email = user?.email || '';
        const reason = document.getElementById('modalReason').value.trim();
        const planned = document.getElementById('modalPlannedReturn').value;
        const modalError = document.getElementById('modalError');
        const consentCheckbox = document.getElementById('consentCheckbox');
        const confirmBtn = document.getElementById('confirmSubmitBtn');

        if (!name || !email || !email.includes('@') || !planned) {
            if (modalError) {
                modalError.textContent = 'Please ensure your profile is complete with name and email, and a return date is selected.';
                modalError.classList.remove('hidden');
            }
            return;
        }
        if (!consentCheckbox.checked) {
            if (modalError) {
                modalError.textContent = 'You must accept the Key Replacement Fee disclaimer.';
                modalError.classList.remove('hidden');
            }
            return;
        }
        if (modalError) modalError.classList.add('hidden');
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Submitting...';
        }

        try {
            const res = await authenticatedFetch('/api/requests/submit', {
                method: 'POST',
                body: JSON.stringify({
                    requester_name: name,
                    requester_email: email,
                    items: basket.map(function(i) { return { key_id: i.id, quantity: 1 }; }),
                    reason: reason || null,
                    planned_return: planned
                })
            });
            const data = await res.json();
            if (res.ok) {
                showNotification('Request Submitted', 'Your key request has been submitted successfully. Awaiting admin approval.', 'success');
                basket = [];
                renderBasket();
                fetchKeys();
                closeRequestModal();
            } else {
                throw new Error(data.error || 'Submission failed');
            }
        } catch (e) {
            showNotification('Submission Failed', e.message, 'error');
            if (modalError) {
                modalError.textContent = 'Submission failed. Please try again.';
                modalError.classList.remove('hidden');
            }
        } finally {
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.textContent = 'Submit request';
            }
        }
    }

    // ============================================================
    // FILTERS
    // ============================================================

    function initFilters() {
        const basketSidebar = document.getElementById('basketSidebar');

        function updateBasketVisibility(filterValue) {
            if (basketSidebar) {
                const shouldHide = (filterValue === 'loaned');
                if (shouldHide) basketSidebar.classList.add('hide-basket');
                else basketSidebar.classList.remove('hide-basket');
            }
        }

        document.querySelectorAll('[data-filter]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                const filterValue = btn.getAttribute('data-filter');
                currentLoanFilter = filterValue;
                document.querySelectorAll('[data-filter]').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                renderFilteredGrid();
                updateBasketVisibility(filterValue);
            });
        });

        document.querySelectorAll('.brand-pill').forEach(function(btn) {
            btn.addEventListener('click', function() {
                currentBrandFilter = btn.getAttribute('data-brand');
                document.querySelectorAll('.brand-pill').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                renderFilteredGrid();
            });
        });

        updateBasketVisibility(currentLoanFilter);
    }

    // ============================================================
    // RETURN DROPDOWN
    // ============================================================

    function initReturnDropdown() {
        const returnDropdownBtn = document.getElementById('returnDropdownBtn');
        const returnDropdownMenu = document.getElementById('returnDropdownMenu');
        const returnDropdownChevron = document.getElementById('returnDropdownChevron');

        if (returnDropdownBtn) {
            returnDropdownBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (returnDropdownMenu) {
                    returnDropdownMenu.classList.toggle('hidden');
                }
                if (returnDropdownChevron) {
                    const isHidden = returnDropdownMenu?.classList.contains('hidden');
                    returnDropdownChevron.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(180deg)';
                }
            });
        }

        document.addEventListener('click', function(e) {
            const container = document.getElementById('returnDropdownContainer');
            if (container && !container.contains(e.target)) {
                if (returnDropdownMenu) {
                    returnDropdownMenu.classList.add('hidden');
                }
                if (returnDropdownChevron) {
                    returnDropdownChevron.style.transform = 'rotate(0deg)';
                }
            }
        });
    }

    // ============================================================
    // RETURN MODAL - FIXED: Loads active loans properly
    // ============================================================

    function initReturnModal() {
        const returnModal = document.getElementById('returnModal');
        const step1 = document.getElementById('returnStep1');
        const step2 = document.getElementById('returnStep2');
        const step3 = document.getElementById('returnStep3');
        const activeLoansContainer = document.getElementById('activeLoansListContainer');
        const submitReturnBtn = document.getElementById('submitReturnConfirmBtn');
        const selectAllBtn = document.getElementById('selectAllReturnBtn');
        const returnSelectionError = document.getElementById('returnSelectionError');
        const fetchLoansBtn = document.getElementById('fetchLoansByEmailBtn');

        function closeReturnModal() {
            if (returnModal) returnModal.style.display = 'none';
            if (step1) step1.style.display = 'block';
            if (step2) step2.style.display = 'none';
            if (step3) step3.style.display = 'none';
            if (activeLoansContainer) activeLoansContainer.innerHTML = '';
        }

        document.getElementById('returnNowBtn')?.addEventListener('click', function() {
            const menu = document.getElementById('returnDropdownMenu');
            const chevron = document.getElementById('returnDropdownChevron');
            if (menu) menu.classList.add('hidden');
            if (chevron) chevron.style.transform = 'rotate(0deg)';
            if (returnModal) returnModal.style.display = 'flex';
            if (step1) step1.style.display = 'none';
            if (step2) step2.style.display = 'block';
            if (step3) step3.style.display = 'none';
            autoLoadUserLoans();
        });

        fetchLoansBtn?.addEventListener('click', autoLoadUserLoans);

        document.getElementById('closeReturnModalBtn')?.addEventListener('click', closeReturnModal);
        document.getElementById('closeReturnSuccessBtn')?.addEventListener('click', closeReturnModal);
        returnModal?.addEventListener('click', function(e) {
            if (e.target === returnModal) closeReturnModal();
        });

        async function autoLoadUserLoans() {
            const user = getUser();
            const email = user?.email || getUserEmail();

            if (!email) {
                if (activeLoansContainer) {
                    activeLoansContainer.innerHTML = '<div class="p-6 text-center text-amber-600 bg-amber-50 rounded-xl">'
                        + '<p class="font-medium">No email found in your profile.</p>'
                        + '<p class="text-sm mt-1">Please update your profile with a valid email address.</p>'
                        + '<button id="goToProfileBtn" class="mt-3 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition">Go to Profile</button>'
                        + '</div>';
                    document.getElementById('goToProfileBtn')?.addEventListener('click', function() {
                        closeReturnModal();
                        openProfileModal();
                    });
                }
                return;
            }

            if (activeLoansContainer) {
                activeLoansContainer.innerHTML = '<div class="text-center py-4"><div class="spinner"></div> Loading your loans...</div>';
            }

            try {
                const response = await authenticatedFetch('/api/return/active-loans?borrower_email=' + encodeURIComponent(email) + '&_=' + Date.now(), {
                    cache: 'no-store',
                    headers: { 'Cache-Control': 'no-cache' }
                });

                if (response.ok) {
                    const data = await response.json();
                    if (!data || data.length === 0) {
                        if (activeLoansContainer) {
                            activeLoansContainer.innerHTML = '<div class="p-6 text-center text-slate-500 bg-gray-50 rounded-xl">'
                                + '<svg class="w-10 h-10 mx-auto mb-2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">'
                                + '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />'
                                + '</svg><p class="font-medium">No active key loans found.</p>'
                                + '<p class="text-sm mt-1">You don\'t have any borrowed keys at the moment.</p></div>';
                        }
                        const step2Header = document.querySelector('#returnStep2 .flex.justify-between.items-center');
                        if (step2Header) step2Header.style.display = 'none';
                        if (submitReturnBtn) submitReturnBtn.style.display = 'none';
                        return;
                    }

                    let loansHtml = '';
                    data.forEach(function(loan) {
                        loansHtml += '<label class="flex items-start gap-3 p-3 border border-gray-200 rounded-xl cursor-pointer hover:bg-slate-50 transition">'
                            + '<input type="checkbox" class="loan-return-checkbox mt-0.5" data-loan-id="' + loan.id + '" data-key-id="' + loan.key_id + '" />'
                            + '<div class="flex-1">'
                            + '<div class="font-medium text-slate-800">' + escapeHtml(loan.key_code) + ' (' + escapeHtml(loan.brand) + ')</div>'
                            + '<div class="text-xs text-slate-500">Borrowed: ' + formatDate(loan.borrowed_at) + ' · Due: ' + formatDate(loan.planned_return) + '</div>'
                            + '</div></label>';
                    });
                    if (activeLoansContainer) {
                        activeLoansContainer.innerHTML = loansHtml;
                    }
                    if (step1) step1.style.display = 'none';
                    if (step2) step2.style.display = 'block';
                    if (step3) step3.style.display = 'none';

                    var checkboxes = function() { return document.querySelectorAll('.loan-return-checkbox'); };
                    var updateSelectAll = function() {
                        var all = checkboxes();
                        var allChecked = all.length > 0 && Array.from(all).every(function(cb) { return cb.checked; });
                        if (selectAllBtn) {
                            selectAllBtn.innerHTML = allChecked ? 'Deselect all' : 'Select all';
                        }
                    };
                    checkboxes().forEach(function(cb) { cb.addEventListener('change', updateSelectAll); });

                    if (selectAllBtn) {
                        selectAllBtn.onclick = function() {
                            var all = checkboxes();
                            var someUnchecked = Array.from(all).some(function(cb) { return !cb.checked; });
                            all.forEach(function(cb) { cb.checked = someUnchecked; });
                            updateSelectAll();
                        };
                    }
                    updateSelectAll();

                    var step2Header = document.querySelector('#returnStep2 .flex.justify-between.items-center');
                    if (step2Header) step2Header.style.display = 'flex';
                    if (submitReturnBtn) submitReturnBtn.style.display = 'block';
                } else {
                    throw new Error('Server returned status: ' + response.status);
                }
            } catch (err) {
                console.error('Return loans error:', err);
                showToast('Error fetching your active loans. Please try again.', 'error');
                if (activeLoansContainer) {
                    activeLoansContainer.innerHTML = '<div class="p-6 text-center text-rose-600 bg-rose-50 rounded-xl">'
                        + '<p class="font-medium">Unable to load your loans.</p>'
                        + '<p class="text-sm mt-1">' + escapeHtml(err.message) + '</p>'
                        + '<button class="mt-3 px-4 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 transition" onclick="location.reload()">Retry</button>'
                        + '</div>';
                }
            }
        }

        submitReturnBtn?.addEventListener('click', async function() {
            const selected = Array.from(document.querySelectorAll('.loan-return-checkbox:checked'));
            if (!selected.length) {
                if (returnSelectionError) {
                    returnSelectionError.innerText = 'Please select at least one key to return.';
                    returnSelectionError.classList.remove('hidden');
                }
                return;
            }
            if (returnSelectionError) returnSelectionError.classList.add('hidden');

            const loanIds = selected.map(function(cb) { return parseInt(cb.dataset.loanId); });
            const selectedKeyIds = selected.map(function(cb) { return parseInt(cb.dataset.keyId); });

            if (submitReturnBtn) {
                submitReturnBtn.disabled = true;
                submitReturnBtn.innerHTML = '<div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div> Processing...';
            }

            const user = getUser();
            const email = user?.email || getUserEmail();

            try {
                const res = await authenticatedFetch('/api/return/request', {
                    method: 'POST',
                    body: JSON.stringify({ borrower_email: email, loan_ids: loanIds })
                });
                const data = await res.json();

                if (res.ok) {
                    allKeys = allKeys.map(function(key) {
                        if (selectedKeyIds.indexOf(key.id) !== -1) {
                            return { ...key, pending_return: true, available: false };
                        }
                        return key;
                    });
                    renderFilteredGrid();

                    showNotification('Return Request Submitted', 'Your return request has been submitted. Please hand the keys to the administrator for verification.', 'success');
                    if (step2) step2.style.display = 'none';
                    if (step3) step3.style.display = 'block';
                } else {
                    throw new Error(data.error || 'Return submission failed');
                }
            } catch (err) {
                console.error('Return submission error:', err);
                showNotification('Return Submission Failed', err.message, 'error');
                if (returnSelectionError) {
                    returnSelectionError.innerText = err.message;
                    returnSelectionError.classList.remove('hidden');
                }
            } finally {
                if (submitReturnBtn) {
                    submitReturnBtn.disabled = false;
                    submitReturnBtn.innerHTML = 'Submit return request →';
                }
            }
        });
    }

    // ============================================================
    // REPORT LOST
    // ============================================================

    function initReportLost() {
        const reportLostModal = document.getElementById('reportLostModal');
        const reportLostKeysContainer = document.getElementById('reportLostKeysListContainer');

        function closeReportLostModal() {
            if (reportLostModal) reportLostModal.style.display = 'none';
        }

        document.getElementById('reportLostKeyBtn')?.addEventListener('click', function() {
            const menu = document.getElementById('returnDropdownMenu');
            const chevron = document.getElementById('returnDropdownChevron');
            if (menu) menu.classList.add('hidden');
            if (chevron) chevron.style.transform = 'rotate(0deg)';
            if (reportLostModal) reportLostModal.style.display = 'flex';
            if (window.autoLoadLostKeys) {
                window.autoLoadLostKeys();
            }
        });

        document.getElementById('closeReportLostModalBtn')?.addEventListener('click', closeReportLostModal);
        reportLostModal?.addEventListener('click', function(e) {
            if (e.target === reportLostModal) closeReportLostModal();
        });

        window.autoLoadLostKeys = async function() {
            const user = getUser();
            const email = user?.email || getUserEmail();

            if (!email) {
                if (reportLostKeysContainer) {
                    reportLostKeysContainer.innerHTML = '<div class="text-center py-8 text-amber-600">'
                        + 'No email found in your profile. Please update your profile.'
                        + '<button class="block mx-auto mt-3 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition" onclick="closeReportLostModal(); openProfileModal();">Go to Profile</button>'
                        + '</div>';
                }
                return;
            }

            if (reportLostKeysContainer) {
                reportLostKeysContainer.innerHTML = '<div class="text-center py-8"><div class="spinner"></div> Loading your borrowed keys...</div>';
            }

            try {
                const res = await authenticatedFetch('/api/user/active-borrows?email=' + encodeURIComponent(email));
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const borrows = await res.json();

                if (!borrows.length) {
                    if (reportLostKeysContainer) {
                        reportLostKeysContainer.innerHTML = '<div class="text-center py-8 text-slate-400">You don\'t have any active borrowed keys.</div>';
                    }
                    return;
                }

                let html = '';
                for (var i = 0; i < borrows.length; i++) {
                    var b = borrows[i];
                    html += '<div class="border border-gray-200 rounded-xl p-3 flex justify-between items-center">'
                        + '<div><div class="font-medium text-slate-800">' + escapeHtml(b.key_code) + ' (' + escapeHtml(b.brand) + ')</div>'
                        + '<div class="text-xs text-slate-500">Borrowed: ' + formatDate(b.borrowed_at) + ' · Due: ' + formatDate(b.planned_return) + '</div></div>'
                        + '<button class="reportLostFromListBtn bg-rose-600 hover:bg-rose-700 text-white text-xs px-3 py-1.5 rounded-full transition" data-transaction-id="' + b.id + '" data-key-code="' + escapeHtml(b.key_code) + '">Report Lost</button>'
                        + '</div>';
                }
                if (reportLostKeysContainer) {
                    reportLostKeysContainer.innerHTML = html;
                }

                document.querySelectorAll('.reportLostFromListBtn').forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        pendingLostTransaction = { id: parseInt(btn.dataset.transactionId), code: btn.dataset.keyCode };
                        const modal = document.getElementById('confirmLostModal');
                        if (modal) {
                            document.getElementById('confirmLostMessage').innerHTML = 'Are you sure you want to report this key as lost? A Key Replacement Fee of 50 SGD will be applied to your account.';
                            modal.style.display = 'flex';
                        }
                    });
                });
            } catch (err) {
                console.error('Load borrowed keys for lost report error:', err);
                if (reportLostKeysContainer) {
                    reportLostKeysContainer.innerHTML = '<div class="text-center py-8 text-rose-600">Error loading borrowed keys. Please try again.</div>';
                }
            }
        };
    }

    function initLostConfirm() {
        function closeLostConfirmModal() {
            const modal = document.getElementById('confirmLostModal');
            if (modal) modal.style.display = 'none';
            pendingLostTransaction = null;
        }

        document.getElementById('confirmLostBtn')?.addEventListener('click', async function() {
            if (!pendingLostTransaction) return;
            const id = pendingLostTransaction.id;
            const code = pendingLostTransaction.code;
            const btn = document.querySelector('.reportLostFromListBtn[data-transaction-id="' + id + '"]');
            const originalText = btn?.innerHTML;
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<div class="spinner"></div>';
            }

            try {
                const res = await authenticatedFetch('/api/user/transactions/' + id + '/lost', { method: 'POST' });
                const data = await res.json();

                if (res.ok) {
                    showNotification('Key Reported Lost', 'The key ' + code + ' has been marked as lost. A Key Replacement Fee of 50 SGD has been applied.', 'warning');
                    await fetchKeys();
                    closeLostConfirmModal();
                    const reportLostModal = document.getElementById('reportLostModal');
                    if (reportLostModal && reportLostModal.style.display === 'flex') {
                        const container = document.getElementById('reportLostKeysListContainer');
                        if (container) {
                            container.innerHTML = '<div class="text-center py-8"><div class="spinner"></div> Refreshing...</div>';
                            setTimeout(function() {
                                if (window.autoLoadLostKeys) {
                                    window.autoLoadLostKeys();
                                }
                            }, 500);
                        }
                    }
                } else {
                    throw new Error(data.error || 'Failed to report lost');
                }
            } catch (err) {
                showNotification('Report Failed', err.message, 'error');
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = originalText;
                }
            }
        });

        document.getElementById('cancelLostBtn')?.addEventListener('click', closeLostConfirmModal);
        document.getElementById('confirmLostModal')?.addEventListener('click', function(e) {
            if (e.target === document.getElementById('confirmLostModal')) closeLostConfirmModal();
        });
    }

    // ============================================================
    // EXTENSION MODAL
    // ============================================================

    function initExtensionModal() {
        document.getElementById('extensionRequestBtn')?.addEventListener('click', function() {
            const menu = document.getElementById('returnDropdownMenu');
            const chevron = document.getElementById('returnDropdownChevron');
            if (menu) menu.classList.add('hidden');
            if (chevron) chevron.style.transform = 'rotate(0deg)';
            const modal = document.getElementById('extensionModal');
            if (modal) modal.style.display = 'flex';
            autoLoadExtensionLoans();
        });

        document.getElementById('closeExtensionModalBtn')?.addEventListener('click', function() {
            const modal = document.getElementById('extensionModal');
            if (modal) modal.style.display = 'none';
        });

        async function autoLoadExtensionLoans() {
            const user = getUser();
            const email = user?.email || getUserEmail();
            const container = document.getElementById('extensionLoansContainer');

            if (!email) {
                if (container) {
                    container.innerHTML = '<div class="text-center py-8 text-amber-600">'
                        + 'No email found in your profile. Please update your profile.'
                        + '<button class="block mx-auto mt-3 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition" onclick="closeExtensionModal(); openProfileModal();">Go to Profile</button>'
                        + '</div>';
                }
                return;
            }

            if (container) {
                container.innerHTML = '<div class="text-center py-8 text-slate-400">Loading your active loans...</div>';
            }

            try {
                const res = await authenticatedFetch('/api/user/active-borrows?email=' + encodeURIComponent(email));
                if (!res.ok) throw new Error('Failed to load loans');
                const loans = await res.json();

                if (!loans.length) {
                    if (container) {
                        container.innerHTML = '<div class="text-center py-8 text-slate-400">You don\'t have any active loans.</div>';
                    }
                    return;
                }

                let html = '<div class="space-y-2">';
                loans.forEach(function(loan) {
                    html += '<div class="extension-item p-3 border border-gray-200 rounded-xl cursor-pointer hover:bg-purple-50 transition" data-transaction-id="' + loan.id + '">'
                        + '<div class="flex justify-between items-center">'
                        + '<div><div class="font-medium text-slate-800">' + escapeHtml(loan.key_code) + '</div>'
                        + '<div class="text-xs text-slate-500">' + escapeHtml(loan.brand) + ' · Due: ' + formatDate(loan.planned_return) + '</div></div>'
                        + '<span class="text-xs text-slate-400">Select</span>'
                        + '</div></div>';
                });
                html += '</div>';
                if (container) {
                    container.innerHTML = html;
                }

                document.querySelectorAll('.extension-item').forEach(function(item) {
                    item.addEventListener('click', function() {
                        document.querySelectorAll('.extension-item').forEach(function(el) { el.classList.remove('selected', 'border-purple-400', 'bg-purple-50'); });
                        this.classList.add('selected', 'border-purple-400', 'bg-purple-50');
                        const selectionArea = document.getElementById('extensionSelectionArea');
                        if (selectionArea) selectionArea.style.display = 'block';
                        const errorDiv = document.getElementById('extensionError');
                        if (errorDiv) errorDiv.classList.add('hidden');
                        const submitBtn = document.getElementById('submitExtensionBtn');
                        if (submitBtn) {
                            submitBtn.dataset.loanId = this.dataset.transactionId;
                            submitBtn.dataset.email = email;
                        }
                    });
                });
            } catch (err) {
                console.error('Extension load error:', err);
                if (container) {
                    container.innerHTML = '<div class="text-center py-8 text-rose-600">Error loading loans. Please try again.</div>';
                }
            }
        }

        document.getElementById('submitExtensionBtn')?.addEventListener('click', async function() {
            const loanId = parseInt(this.dataset.loanId);
            const email = this.dataset.email || getUserEmail();
            const newReturnDate = document.getElementById('extensionNewReturnDate').value;
            const extensionError = document.getElementById('extensionError');

            if (!loanId) {
                if (extensionError) {
                    extensionError.textContent = 'Please select a loan to extend.';
                    extensionError.classList.remove('hidden');
                }
                return;
            }

            if (!newReturnDate) {
                if (extensionError) {
                    extensionError.textContent = 'Please select a new return date.';
                    extensionError.classList.remove('hidden');
                }
                return;
            }

            if (extensionError) extensionError.classList.add('hidden');
            this.disabled = true;
            this.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';

            try {
                const res = await authenticatedFetch('/api/requests/extend', {
                    method: 'POST',
                    body: JSON.stringify({
                        transaction_id: loanId,
                        new_return_date: newReturnDate,
                        borrower_email: email
                    })
                });
                const data = await res.json();

                if (res.ok) {
                    showNotification('Extension Requested', 'Your extension request has been submitted. Awaiting admin approval.', 'success');
                    const modal = document.getElementById('extensionModal');
                    if (modal) modal.style.display = 'none';
                    fetchKeys();
                } else {
                    throw new Error(data.error || 'Extension request failed');
                }
            } catch (err) {
                if (extensionError) {
                    extensionError.textContent = err.message;
                    extensionError.classList.remove('hidden');
                }
            } finally {
                this.disabled = false;
                this.innerHTML = 'Submit extension request';
            }
        });
    }

    // ============================================================
    // POLLING & INIT
    // ============================================================

    function startPolling() {
        if (pollInterval) clearInterval(pollInterval);
        fetchKeys();
        pollInterval = setInterval(fetchKeys, 5000);
    }

    // FIX: Admin portal button visibility - only show for admin users
    function updateAdminMenuVisibility() {
        const adminMenuItems = document.querySelectorAll('.mobile-menu-item[href="/admin"]');
        const isUserAdmin = isAdmin();
        adminMenuItems.forEach(function(item) {
            if (item) {
                item.style.display = isUserAdmin ? 'flex' : 'none';
            }
        });
    }

    async function init() {
        const isAuthenticated = await checkAuth();
        if (isAuthenticated) {
            const loadingContainer = document.getElementById('loadingContainer');
            const mainContentWrapper = document.getElementById('mainContentWrapper');

            if (loadingContainer) loadingContainer.style.display = 'none';
            if (mainContentWrapper) mainContentWrapper.style.display = 'block';

            // FIX: Update admin menu visibility based on role
            updateAdminMenuVisibility();

            await ensureCsrfToken();
            initEventListeners();
            initFilters();
            initReturnDropdown();
            initReturnModal();
            initReportLost();
            initLostConfirm();
            initExtensionModal();
            startPolling();
        }
    }

    document.addEventListener('DOMContentLoaded', init);
})();