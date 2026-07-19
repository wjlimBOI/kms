const { z } = require('zod');
const { MIN_PASSWORD_LENGTH } = require('./passwordValidator');

const emailSchema = z.string().email('Invalid email address');
const nameSchema = z.string().min(1, 'Name is required').max(100);

const passwordSchema = z.string()
  .min(MIN_PASSWORD_LENGTH, `At least ${MIN_PASSWORD_LENGTH} characters`)
  .regex(/[A-Z]/, 'At least one uppercase')
  .regex(/[a-z]/, 'At least one lowercase')
  .regex(/[0-9]/, 'At least one number')
  .regex(/[^A-Za-z0-9]/, 'At least one special character');

const userSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  role: z.enum(['admin', 'editor', 'viewer']),
  status: z.enum(['active', 'inactive', 'suspended'])
});

const keyItemSchema = z.object({
  key_id: z.number().int().positive(),
  quantity: z.number().int().min(1)
});

const requestSchema = z.object({
  requester_name: nameSchema,
  requester_email: emailSchema,
  items: z.array(keyItemSchema).min(1, 'At least one key required'),
  reason: z.string().optional(),
  planned_return: z.string().datetime({ offset: true }),
  borrow_datetime: z.string().datetime({ offset: true }).optional(),
  borrow_type: z.enum(['now', 'today']).optional()
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: passwordSchema
});

const firstPasswordSchema = z.object({
  new_password: passwordSchema
});

const extensionSchema = z.object({
  transaction_id: z.number().int().positive(),
  new_return_date: z.string().datetime({ offset: true }),
  borrower_email: emailSchema
});

module.exports = {
  userSchema,
  requestSchema,
  loginSchema,
  changePasswordSchema,
  firstPasswordSchema,
  emailSchema,
  nameSchema,
  passwordSchema,
  extensionSchema
};