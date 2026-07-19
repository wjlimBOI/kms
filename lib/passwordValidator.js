const COMMON_PASSWORDS = new Set([
  '123456', 'password', '12345678', 'qwerty', 'abc123', '111111',
  '12345', '123456789', 'letmein', '1234567', 'welcome', 'monkey',
  'password1', '123123', '654321', 'password!', '1234567890',
  'qwerty123', '1q2w3e4r', 'qwertyuiop', 'abcdefg', 'aaaaaa',
  'admin', 'admin123', 'root', 'root123', 'toor', 'passw0rd',
]);

const MIN_PASSWORD_LENGTH = 16;

function validatePasswordComplexity(password) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { valid: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.` };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one uppercase letter.' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one lowercase letter.' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one number.' };
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one special character.' };
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { valid: false, message: 'This password is too common and easy to guess.' };
  }
  return { valid: true };
}

module.exports = { validatePasswordComplexity, MIN_PASSWORD_LENGTH };