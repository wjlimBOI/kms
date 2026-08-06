(function() {
    'use strict';

    let isRedirecting = false;
    let redirectTimer = null;
    let isRedirectingFromModal = false;

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

    function redirectToDashboard() {
        if (isRedirecting || isRedirectingFromModal) return;
        isRedirecting = true;
        window.location.href = '/?t=' + Date.now();
    }

    function showMessage(text, type) {
        var messageDiv = document.getElementById('message');
        if (!messageDiv) return;
        messageDiv.textContent = text;
        messageDiv.className = 'alert-box ' + type;
        messageDiv.classList.remove('hidden');
    }

    function showSuccessModal() {
        var modal = document.getElementById('successModal');
        if (!modal) return;
        modal.classList.add('active');
    }

    function hideSuccessModal() {
        var modal = document.getElementById('successModal');
        if (!modal) return;
        modal.classList.remove('active');
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

    document.addEventListener('DOMContentLoaded', function() {
        var form = document.getElementById('changeForm');
        var currentInput = document.getElementById('currentPassword');
        var newInput = document.getElementById('newPassword');
        var confirmInput = document.getElementById('confirmPassword');
        var currentError = document.getElementById('currentError');
        var newError = document.getElementById('newError');
        var confirmError = document.getElementById('confirmError');
        var infoBox = document.getElementById('infoBox');
        var changeBtn = document.getElementById('changeBtn');
        var successModalBtn = document.getElementById('successModalBtn');

        if (!form || !currentInput || !newInput || !confirmInput || !changeBtn) {
            console.error('Required elements not found');
            return;
        }

        // Initialize CSRF token
        ensureCsrfToken();

        // Initialize toggle buttons
        initToggleButtons();

        // Success modal button - redirect to dashboard
        if (successModalBtn) {
            successModalBtn.addEventListener('click', function() {
                if (isRedirectingFromModal) return;
                isRedirectingFromModal = true;
                hideSuccessModal();
                // Clear any pending timer
                if (redirectTimer) {
                    clearTimeout(redirectTimer);
                    redirectTimer = null;
                }
                redirectToDashboard();
            });
        }

        // Close modal on overlay click
        var modal = document.getElementById('successModal');
        if (modal) {
            modal.addEventListener('click', function(e) {
                if (e.target === this) {
                    // Don't close if user clicks overlay - let them use the button
                    // But we can close it if they click outside the container
                    // Actually, let's keep it open so they don't miss it
                }
            });
        }

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

        // Check session and redirect if not required to change password
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

                // If user does NOT need to change password, redirect immediately
                if (!data.mustChangePassword) {
                    if (infoBox) infoBox.classList.add('hidden');
                    redirectToDashboard();
                    return;
                }

                // User needs to change password - show the form
                if (infoBox) infoBox.classList.remove('hidden');

            } catch (err) {
                console.error('Session check error:', err);
            }
        })();

        form.addEventListener('submit', async function(e) {
            e.preventDefault();

            document.querySelectorAll('.field-error').forEach(function(el) {
                el.classList.remove('visible');
            });
            var messageDiv = document.getElementById('message');
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
                    // Clear any existing timer
                    if (redirectTimer) {
                        clearTimeout(redirectTimer);
                        redirectTimer = null;
                    }

                    // Clear local storage to force fresh session
                    localStorage.removeItem('kms_token');
                    localStorage.removeItem('kms_user');
                    sessionStorage.clear();

                    // Show success modal
                    showSuccessModal();

                    // Auto-redirect after 5 seconds if user doesn't click the button
                    redirectTimer = setTimeout(function() {
                        if (!isRedirectingFromModal) {
                            isRedirectingFromModal = true;
                            hideSuccessModal();
                            redirectToDashboard();
                        }
                    }, 5000);

                    // Reset button state
                    changeBtn.disabled = false;
                    changeBtn.innerHTML = originalText;

                } else if (res.status === 401) {
                    // Session expired - redirect to login
                    if (redirectTimer) {
                        clearTimeout(redirectTimer);
                        redirectTimer = null;
                    }
                    redirectToLogin();
                } else {
                    showMessage(data.error || 'Failed to update password. Please try again.', 'alert-error');
                    changeBtn.disabled = false;
                    changeBtn.innerHTML = originalText;
                }
            } catch (err) {
                console.error('Password update error:', err);
                showMessage('Network error. Please try again.', 'alert-error');
                changeBtn.disabled = false;
                changeBtn.innerHTML = originalText;
            }
        });

        // Handle page visibility change to prevent loops
        document.addEventListener('visibilitychange', function() {
            if (document.hidden) {
                if (redirectTimer) {
                    clearTimeout(redirectTimer);
                    redirectTimer = null;
                }
            }
        });

        // Handle beforeunload to prevent loops
        window.addEventListener('beforeunload', function() {
            if (redirectTimer) {
                clearTimeout(redirectTimer);
                redirectTimer = null;
            }
        });
    });
})();