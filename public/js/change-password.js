(function() {
    'use strict';

    let isRedirecting = false;

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

    async function handleLogout() {
        if (isRedirecting) return;
        isRedirecting = true;
        try {
            const token = localStorage.getItem('kms_token');
            if (token) {
                await fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + token,
                        'Content-Type': 'application/json'
                    },
                    credentials: 'include'
                }).catch(function() {});
            }
        } catch (error) {
            console.error('Logout error:', error);
        } finally {
            localStorage.removeItem('kms_token');
            localStorage.removeItem('kms_user');
            sessionStorage.clear();
            document.cookie.split(";").forEach(function(c) {
                document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
            });
            window.location.href = '/login?t=' + Date.now();
        }
    }

    function initToggleButtons() {
        var toggleButtons = document.querySelectorAll('.toggle-password');

        toggleButtons.forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();

                var wrapper = this.closest('.input-wrapper');
                if (!wrapper) return;

                var input = wrapper.querySelector('input');
                var icon = this.querySelector('i');

                if (!input || !icon) return;

                if (input.type === 'password') {
                    input.type = 'text';
                    icon.classList.remove('fa-eye');
                    icon.classList.add('fa-eye-slash');
                } else {
                    input.type = 'password';
                    icon.classList.remove('fa-eye-slash');
                    icon.classList.add('fa-eye');
                }

                input.focus();
            });
        });
    }

    function showMessage(text, type) {
        var messageDiv = document.getElementById('message');
        if (!messageDiv) return;
        messageDiv.textContent = text;
        messageDiv.className = 'alert-box ' + type;
        messageDiv.classList.remove('hidden');
    }

    document.addEventListener('DOMContentLoaded', function() {
        ensureCsrfToken();

        var form = document.getElementById('changeForm');
        var currentInput = document.getElementById('currentPassword');
        var newInput = document.getElementById('newPassword');
        var confirmInput = document.getElementById('confirmPassword');
        var currentError = document.getElementById('currentError');
        var newError = document.getElementById('newError');
        var confirmError = document.getElementById('confirmError');
        var messageDiv = document.getElementById('message');
        var infoBox = document.getElementById('infoBox');
        var changeBtn = document.getElementById('changeBtn');

        if (!form || !currentInput || !newInput || !confirmInput || !changeBtn) {
            console.error('Required elements not found');
            return;
        }

        initToggleButtons();

        function validateForm() {
            var current = currentInput.value.trim();
            var newPwd = newInput.value.trim();
            var confirm = confirmInput.value.trim();
            changeBtn.disabled = !(current && newPwd && confirm);
        }

        [currentInput, newInput, confirmInput].forEach(function(field) {
            field.addEventListener('input', function() {
                document.querySelectorAll('.field-error').forEach(function(el) {
                    el.classList.remove('visible');
                });
                validateForm();
            });
        });

        (async function checkSession() {
            try {
                var csrf = await getCsrfToken();
                var res = await fetch('/api/auth/session', {
                    credentials: 'include',
                    headers: {
                        'X-CSRF-Token': csrf || '',
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                });
                if (res.status === 401) {
                    redirectToLogin();
                    return;
                }
                var data = await res.json();
                if (!data.loggedIn) {
                    redirectToLogin();
                    return;
                }
                if (infoBox) {
                    infoBox.classList.toggle('hidden', !data.mustChangePassword);
                }
            } catch (err) {
                console.error('Session check error:', err);
                redirectToLogin();
            }
        })();

        form.addEventListener('submit', async function(e) {
            e.preventDefault();

            document.querySelectorAll('.field-error').forEach(function(el) {
                el.classList.remove('visible');
            });
            if (messageDiv) messageDiv.classList.add('hidden');

            var current = currentInput.value.trim();
            var newPwd = newInput.value.trim();
            var confirm = confirmInput.value.trim();

            var valid = true;

            if (!current) {
                if (currentError) {
                    currentError.textContent = 'Current password is required.';
                    currentError.classList.add('visible');
                }
                valid = false;
            }

            if (!newPwd) {
                if (newError) {
                    newError.textContent = 'New password is required.';
                    newError.classList.add('visible');
                }
                valid = false;
            }

            if (!confirm) {
                if (confirmError) {
                    confirmError.textContent = 'Please confirm your new password.';
                    confirmError.classList.add('visible');
                }
                valid = false;
            }

            if (newPwd && confirm && newPwd !== confirm) {
                if (confirmError) {
                    confirmError.textContent = 'Passwords do not match.';
                    confirmError.classList.add('visible');
                }
                valid = false;
            }

            if (newPwd && newPwd.length < 16) {
                if (newError) {
                    newError.textContent = 'Password must be at least 16 characters.';
                    newError.classList.add('visible');
                }
                valid = false;
            }

            if (!valid) return;

            var originalText = changeBtn.innerHTML;
            changeBtn.disabled = true;
            changeBtn.innerHTML = '<div class="spinner"></div> Updating...';

            try {
                var csrf = await getCsrfToken();
                if (!csrf) {
                    showMessage('Failed to get CSRF token. Please refresh and try again.', 'alert-error');
                    changeBtn.disabled = false;
                    changeBtn.innerHTML = originalText;
                    return;
                }

                var res = await fetch('/api/auth/change-password', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrf,
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: JSON.stringify({
                        current_password: current,
                        new_password: newPwd
                    }),
                    credentials: 'include'
                });

                var data = await res.json();

                if (res.ok) {
                    showMessage('✅ Password updated successfully!', 'alert-success');
                    setTimeout(function() {
                        window.location.href = '/';
                    }, 2000);
                } else if (res.status === 401) {
                    handleLogout();
                } else {
                    showMessage(data.error || 'Failed to update password.', 'alert-error');
                }
            } catch (err) {
                console.error('Password update error:', err);
                showMessage('Network error. Please try again.', 'alert-error');
            } finally {
                changeBtn.disabled = false;
                changeBtn.innerHTML = originalText;
            }
        });
    });
})();