(function() {
    'use strict';

    let isRedirecting = false;
    let sessionCheckDone = false;

    // Force clear all client-side data
    function forceClearAll() {
        try {
            localStorage.clear();
        } catch(e) {
            console.warn('localStorage clear failed:', e);
        }
        
        try {
            sessionStorage.clear();
        } catch(e) {
            console.warn('sessionStorage clear failed:', e);
        }
        
        try {
            document.cookie.split(";").forEach(function(c) {
                document.cookie = c.replace(/^ +/, "")
                    .replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
                document.cookie = c.replace(/^ +/, "")
                    .replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/;domain=" + window.location.hostname);
            });
        } catch(e) {
            console.warn('Cookie clear failed:', e);
        }
    }

    function redirectToLogin(force) {
        if (isRedirecting) return;
        isRedirecting = true;
        forceClearAll();
        const url = force ? '/login?force=true&t=' + Date.now() : '/login?t=' + Date.now();
        window.location.replace(url);
    }

    async function checkSessionAndRedirect() {
        // Check if we're on login page and have force parameter
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('force') || urlParams.has('forced') || urlParams.has('logout')) {
            // Force clear everything and stay on login page
            forceClearAll();
            // Clean URL
            const newUrl = window.location.pathname;
            window.history.replaceState({}, document.title, newUrl);
            return false;
        }

        // Check if token exists - if not, stay on login
        const token = localStorage.getItem('kms_token');
        if (!token) {
            return false;
        }

        if (sessionCheckDone) return false;
        sessionCheckDone = true;

        try {
            const response = await fetch('/api/auth/check-session', {
                credentials: 'include',
                headers: { 
                    'Accept': 'application/json',
                    'Authorization': 'Bearer ' + token
                }
            });

            if (!response.ok) {
                // Session invalid, clear storage
                forceClearAll();
                return false;
            }

            const data = await response.json();
            
            if (data.authenticated && data.user) {
                const currentPath = window.location.pathname;
                const targetPath = data.user.role === 'admin' ? '/admin' : '/';
                
                // Prevent redirect loop - check if already on target
                if (currentPath === targetPath || 
                    (targetPath === '/admin' && currentPath.startsWith('/admin')) ||
                    (targetPath === '/' && currentPath === '/')) {
                    return true;
                }
                
                // Store user data
                localStorage.setItem('kms_user', JSON.stringify(data.user));
                if (data.token) {
                    localStorage.setItem('kms_token', data.token);
                }
                
                isRedirecting = true;
                window.location.replace(targetPath);
                return true;
            }
            return false;
        } catch (error) {
            console.error('Session check error:', error);
            sessionCheckDone = false;
            // On error, don't redirect - stay on login page
            return false;
        }
    }

    function showLoginForm() {
        const loadingContainer = document.getElementById('loadingContainer');
        const loginFormContainer = document.getElementById('loginFormContainer');
        if (loadingContainer) loadingContainer.style.display = 'none';
        if (loginFormContainer) loginFormContainer.style.display = 'block';
    }

    async function init() {
        // Check if we're on login page
        if (window.location.pathname === '/login' || window.location.pathname === '/login/') {
            // Check for force parameters
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.has('force') || urlParams.has('forced') || urlParams.has('logout')) {
                forceClearAll();
                // Clean URL
                const newUrl = window.location.pathname;
                window.history.replaceState({}, document.title, newUrl);
            }

            await ensureCsrfToken();
            const isRedirected = await checkSessionAndRedirect();
            if (!isRedirected && !isRedirecting) {
                showLoginForm();
                initializeEventListeners();
            }
        } else {
            // If not on login page, check if we have a valid session
            const token = localStorage.getItem('kms_token');
            if (!token) {
                redirectToLogin(true);
            } else {
                // Verify session
                try {
                    const response = await fetch('/api/auth/check-session', {
                        credentials: 'include',
                        headers: { 
                            'Accept': 'application/json',
                            'Authorization': 'Bearer ' + token
                        }
                    });
                    if (!response.ok) {
                        redirectToLogin(true);
                    } else {
                        const data = await response.json();
                        if (!data.authenticated) {
                            redirectToLogin(true);
                        }
                    }
                } catch (error) {
                    redirectToLogin(true);
                }
            }
        }
    }

    function initializeEventListeners() {
        const loginForm = document.getElementById('loginForm');
        const usernameInput = document.getElementById('username');
        const passwordInput = document.getElementById('password');
        const usernameError = document.getElementById('usernameError');
        const passwordError = document.getElementById('passwordError');
        const errorDiv = document.getElementById('errorMsg');
        const errorText = document.getElementById('errorText');
        const lockoutDiv = document.getElementById('lockoutMsg');
        const lockoutText = document.getElementById('lockoutText');
        const loginBtn = document.getElementById('loginBtn');
        const lockoutWarningDiv = document.getElementById('lockoutWarning');
        const lockoutWarningText = document.getElementById('lockoutWarningText');
        const toggleBtn = document.querySelector('.toggle-password');
        const toggleIcon = toggleBtn?.querySelector('i');

        const registerModal = document.getElementById('registerModal');
        const openRegisterBtn = document.getElementById('openRegisterModalBtn');
        const closeRegisterBtn = document.getElementById('closeRegisterModalBtn');
        const cancelRegisterBtn = document.getElementById('cancelRegisterBtn');
        const registerForm = document.getElementById('registerForm');
        const regName = document.getElementById('regName');
        const regEmail = document.getElementById('regEmail');
        const regNameError = document.getElementById('regNameError');
        const regEmailError = document.getElementById('regEmailError');
        const registerAlert = document.getElementById('registerAlert');
        const registerBtn = document.getElementById('registerBtn');

        const forgotPasswordModal = document.getElementById('forgotPasswordModal');
        const forgotPasswordBtn = document.getElementById('forgotPasswordBtn');
        const closeForgotPasswordModalBtn = document.getElementById('closeForgotPasswordModalBtn');
        const cancelResetBtn = document.getElementById('cancelResetBtn');
        const forgotPasswordForm = document.getElementById('forgotPasswordForm');
        const resetEmail = document.getElementById('resetEmail');
        const resetEmailError = document.getElementById('resetEmailError');
        const resetAlert = document.getElementById('resetAlert');
        const resetBtn = document.getElementById('resetBtn');

        const infoTrigger = document.getElementById('infoTrigger');
        const tooltipPopup = document.getElementById('tooltipPopup');

        let failedAttempts = 0;

        function hideAllAlerts() {
            errorDiv?.classList.add('hidden');
            lockoutDiv?.classList.add('hidden');
        }

        function showError(msg) {
            if (errorText) errorText.textContent = msg;
            errorDiv?.classList.remove('hidden');
            lockoutDiv?.classList.add('hidden');
        }

        function showLockout(msg) {
            if (lockoutText) lockoutText.textContent = msg;
            lockoutDiv?.classList.remove('hidden');
            errorDiv?.classList.add('hidden');
            lockoutWarningDiv?.classList.remove('visible');
        }

        function showRegisterAlert(msg, type) {
            if (registerAlert) {
                registerAlert.textContent = msg;
                registerAlert.className = 'modal-alert visible ' + type;
            }
        }

        function hideRegisterAlert() {
            if (registerAlert) registerAlert.className = 'modal-alert';
        }

        function showResetAlert(msg, type) {
            if (resetAlert) {
                resetAlert.textContent = msg;
                resetAlert.className = 'modal-alert visible ' + type;
            }
        }

        function hideResetAlert() {
            if (resetAlert) resetAlert.className = 'modal-alert';
        }

        if (usernameInput) {
            usernameInput.addEventListener('input', () => {
                usernameError?.classList.remove('visible');
                hideAllAlerts();
            });
        }

        if (passwordInput) {
            passwordInput.addEventListener('input', () => {
                passwordError?.classList.remove('visible');
                hideAllAlerts();
            });
        }

        if (toggleBtn && toggleIcon && passwordInput) {
            toggleBtn.addEventListener('click', function() {
                const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
                passwordInput.setAttribute('type', type);
                toggleIcon.classList.toggle('fa-eye');
                toggleIcon.classList.toggle('fa-eye-slash');
            });
        }

        if (infoTrigger && tooltipPopup) {
            infoTrigger.addEventListener('click', function(e) {
                e.stopPropagation();
                tooltipPopup.classList.toggle('show');
            });
            document.addEventListener('click', function(e) {
                if (!e.target.closest('.info-trigger-wrapper')) {
                    tooltipPopup?.classList.remove('show');
                }
            });
        }

        if (loginForm) {
            loginForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                usernameError?.classList.remove('visible');
                passwordError?.classList.remove('visible');
                hideAllAlerts();

                const username = usernameInput?.value.trim() || '';
                const password = passwordInput?.value || '';

                let valid = true;
                if (!username) {
                    if (usernameError) {
                        usernameError.textContent = 'Username is required';
                        usernameError.classList.add('visible');
                    }
                    valid = false;
                }
                if (!password) {
                    if (passwordError) {
                        passwordError.textContent = 'Password is required';
                        passwordError.classList.add('visible');
                    }
                    valid = false;
                }
                if (!valid) return;

                const originalText = loginBtn?.innerHTML || 'Sign in →';
                if (loginBtn) {
                    loginBtn.disabled = true;
                    loginBtn.innerHTML = '<div class="spinner"></div> Authenticating...';
                }

                try {
                    const csrf = await getCsrfToken();
                    if (!csrf) {
                        showError('Failed to get CSRF token. Please refresh and try again.');
                        if (loginBtn) {
                            loginBtn.disabled = false;
                            loginBtn.innerHTML = originalText;
                        }
                        return;
                    }

                    const response = await fetch('/api/auth/login', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': csrf,
                            'X-Requested-With': 'XMLHttpRequest'
                        },
                        body: JSON.stringify({ username, password }),
                        credentials: 'include'
                    });

                    const data = await response.json();

                    if (response.ok && data.token) {
                        failedAttempts = 0;
                        lockoutWarningDiv?.classList.remove('visible');
                        localStorage.setItem('kms_token', data.token);
                        const user = data.user || { username, role: data.role || 'user', name: data.name || username };
                        localStorage.setItem('kms_user', JSON.stringify(user));
                        if (data.mustChangePassword) {
                            window.location.replace('/change-password');
                            return;
                        }
                        window.location.replace(data.role === 'admin' ? '/admin' : '/');
                        return;
                    }

                    if (response.status === 403) {
                        lockoutWarningDiv?.classList.remove('visible');
                        showLockout(data.error || 'Account is temporarily locked.');
                    } else if (response.status === 401) {
                        failedAttempts++;
                        const remaining = 5 - failedAttempts;
                        if (remaining > 0 && remaining <= 3) {
                            if (lockoutWarningText) {
                                lockoutWarningText.textContent =
                                    `⚠️ Warning: You have ${remaining} out of 5 attempts remaining. Your account will be locked after 5 failed attempts.`;
                            }
                            lockoutWarningDiv?.classList.add('visible');
                        } else {
                            lockoutWarningDiv?.classList.remove('visible');
                        }
                        if (remaining <= 0) {
                            lockoutWarningDiv?.classList.remove('visible');
                            showLockout('Account is temporarily locked due to too many failed attempts.');
                        } else {
                            showError('Invalid username or password.');
                        }
                    } else {
                        showError(data.error || 'An error occurred. Please try again.');
                    }
                } catch (err) {
                    console.error('Login error:', err);
                    showError('Network error. Please check your connection.');
                } finally {
                    if (loginBtn) {
                        loginBtn.disabled = false;
                        loginBtn.innerHTML = originalText;
                    }
                }
            });
        }

        function openRegisterModal() {
            registerModal?.classList.add('active');
            if (regName) regName.value = '';
            if (regEmail) regEmail.value = '';
            hideRegisterAlert();
            regNameError?.classList.remove('visible');
            regEmailError?.classList.remove('visible');
            if (registerBtn) {
                registerBtn.disabled = false;
                registerBtn.innerHTML = 'Submit request';
            }
            tooltipPopup?.classList.remove('show');
        }

        function closeRegisterModal() {
            registerModal?.classList.remove('active');
            tooltipPopup?.classList.remove('show');
        }

        if (openRegisterBtn) openRegisterBtn.addEventListener('click', openRegisterModal);
        if (closeRegisterBtn) closeRegisterBtn.addEventListener('click', closeRegisterModal);
        if (cancelRegisterBtn) cancelRegisterBtn.addEventListener('click', closeRegisterModal);
        if (registerModal) {
            registerModal.addEventListener('click', function(e) {
                if (e.target === this) closeRegisterModal();
            });
        }
        if (regName) {
            regName.addEventListener('input', () => {
                regNameError?.classList.remove('visible');
                hideRegisterAlert();
            });
        }
        if (regEmail) {
            regEmail.addEventListener('input', () => {
                regEmailError?.classList.remove('visible');
                hideRegisterAlert();
            });
        }

        if (registerForm) {
            registerForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                regNameError?.classList.remove('visible');
                regEmailError?.classList.remove('visible');
                hideRegisterAlert();

                const name = regName?.value.trim() || '';
                const email = regEmail?.value.trim() || '';

                let valid = true;
                if (!name) {
                    if (regNameError) {
                        regNameError.textContent = 'Name is required';
                        regNameError.classList.add('visible');
                    }
                    valid = false;
                }
                if (!email || !email.includes('@')) {
                    if (regEmailError) {
                        regEmailError.textContent = 'Valid email is required';
                        regEmailError.classList.add('visible');
                    }
                    valid = false;
                }
                if (!valid) return;

                const originalText = registerBtn?.innerHTML || 'Submit request';
                if (registerBtn) {
                    registerBtn.disabled = true;
                    registerBtn.innerHTML = '<div class="spinner"></div> Checking...';
                }

                try {
                    const csrf = await getCsrfToken();
                    if (!csrf) {
                        showRegisterAlert('Failed to get CSRF token. Please refresh and try again.', 'error');
                        if (registerBtn) {
                            registerBtn.disabled = false;
                            registerBtn.innerHTML = originalText;
                        }
                        return;
                    }

                    const checkResponse = await fetch('/api/auth/check-registration-status', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': csrf,
                            'X-Requested-With': 'XMLHttpRequest'
                        },
                        body: JSON.stringify({ email }),
                        credentials: 'include'
                    });

                    const checkData = await checkResponse.json();

                    if (checkResponse.ok) {
                        if (checkData.isRegistered) {
                            showRegisterAlert('This email is already registered. Please login instead.', 'error');
                            if (registerBtn) {
                                registerBtn.disabled = false;
                                registerBtn.innerHTML = originalText;
                            }
                            return;
                        }
                        if (checkData.hasPending) {
                            showRegisterAlert('You already have a pending request. Please wait for admin approval.', 'warning');
                            if (registerBtn) {
                                registerBtn.disabled = false;
                                registerBtn.innerHTML = originalText;
                            }
                            return;
                        }
                    }

                    if (registerBtn) registerBtn.innerHTML = '<div class="spinner"></div> Submitting...';

                    const response = await fetch('/api/auth/register-request', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': csrf,
                            'X-Requested-With': 'XMLHttpRequest'
                        },
                        body: JSON.stringify({ name, email }),
                        credentials: 'include'
                    });

                    const data = await response.json();

                    if (response.ok) {
                        showRegisterAlert('✅ Request submitted! You will receive an email once approved.', 'success');
                        if (registerBtn) registerBtn.innerHTML = '✓ Done';
                        setTimeout(() => {
                            closeRegisterModal();
                            if (registerBtn) {
                                registerBtn.disabled = false;
                                registerBtn.innerHTML = originalText;
                            }
                        }, 2500);
                    } else {
                        showRegisterAlert(data.error || 'Submission failed. Please try again.', 'error');
                        if (registerBtn) {
                            registerBtn.disabled = false;
                            registerBtn.innerHTML = originalText;
                        }
                    }
                } catch (err) {
                    console.error('Registration error:', err);
                    showRegisterAlert('Network error. Please check your connection.', 'error');
                    if (registerBtn) {
                        registerBtn.disabled = false;
                        registerBtn.innerHTML = originalText;
                    }
                }
            });
        }

        function openForgotPasswordModal() {
            forgotPasswordModal?.classList.add('active');
            if (resetEmail) resetEmail.value = '';
            hideResetAlert();
            resetEmailError?.classList.remove('visible');
            if (resetBtn) {
                resetBtn.disabled = false;
                resetBtn.innerHTML = 'Send Reset Link';
            }
        }

        function closeForgotPasswordModal() {
            forgotPasswordModal?.classList.remove('active');
        }

        if (forgotPasswordBtn) forgotPasswordBtn.addEventListener('click', openForgotPasswordModal);
        if (closeForgotPasswordModalBtn) closeForgotPasswordModalBtn.addEventListener('click', closeForgotPasswordModal);
        if (cancelResetBtn) cancelResetBtn.addEventListener('click', closeForgotPasswordModal);
        if (forgotPasswordModal) {
            forgotPasswordModal.addEventListener('click', function(e) {
                if (e.target === this) closeForgotPasswordModal();
            });
        }
        if (resetEmail) {
            resetEmail.addEventListener('input', () => {
                resetEmailError?.classList.remove('visible');
                hideResetAlert();
            });
        }

        if (forgotPasswordForm) {
            forgotPasswordForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                resetEmailError?.classList.remove('visible');
                hideResetAlert();

                const email = resetEmail?.value.trim() || '';

                if (!email || !email.includes('@')) {
                    if (resetEmailError) {
                        resetEmailError.textContent = 'Valid email is required';
                        resetEmailError.classList.add('visible');
                    }
                    return;
                }

                const originalText = resetBtn?.innerHTML || 'Send Reset Link';
                if (resetBtn) {
                    resetBtn.disabled = true;
                    resetBtn.innerHTML = '<div class="spinner"></div> Sending...';
                }

                try {
                    const csrf = await getCsrfToken();
                    if (!csrf) {
                        showResetAlert('Failed to get CSRF token. Please refresh and try again.', 'error');
                        if (resetBtn) {
                            resetBtn.disabled = false;
                            resetBtn.innerHTML = originalText;
                        }
                        return;
                    }

                    const response = await fetch('/api/auth/forgot-password', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': csrf,
                            'X-Requested-With': 'XMLHttpRequest'
                        },
                        body: JSON.stringify({ email }),
                        credentials: 'include'
                    });

                    const data = await response.json();

                    if (response.ok) {
                        showResetAlert('✅ Password reset link sent to your email.', 'success');
                        if (resetBtn) resetBtn.innerHTML = '✓ Sent';
                        setTimeout(() => {
                            closeForgotPasswordModal();
                            if (resetBtn) {
                                resetBtn.disabled = false;
                                resetBtn.innerHTML = originalText;
                            }
                        }, 2500);
                    } else {
                        showResetAlert(data.error || 'Failed to send reset link. Please try again.', 'error');
                        if (resetBtn) {
                            resetBtn.disabled = false;
                            resetBtn.innerHTML = originalText;
                        }
                    }
                } catch (err) {
                    console.error('Forgot password error:', err);
                    showResetAlert('Network error. Please check your connection.', 'error');
                    if (resetBtn) {
                        resetBtn.disabled = false;
                        resetBtn.innerHTML = originalText;
                    }
                }
            });
        }
    }

    // CSRF token functions with fallback
    async function ensureCsrfToken() {
        if (typeof window.ensureCsrfToken === 'function') {
            return await window.ensureCsrfToken();
        }
        try {
            const response = await fetch('/api/csrf-token', {
                credentials: 'include',
                headers: { 'Accept': 'application/json' }
            });
            if (response.ok) {
                const data = await response.json();
                window.csrfToken = data.csrfToken;
                return data.csrfToken;
            }
            return null;
        } catch (err) {
            console.error('CSRF token fallback error:', err);
            return null;
        }
    }

    async function getCsrfToken() {
        if (typeof window.getCsrfToken === 'function') {
            return await window.getCsrfToken();
        }
        return window.csrfToken || await ensureCsrfToken();
    }

    // Expose force logout function globally
    window.forceLogout = function() {
        forceClearAll();
        window.location.replace('/login?force=true&t=' + Date.now());
    };

    document.addEventListener('DOMContentLoaded', init);
})();