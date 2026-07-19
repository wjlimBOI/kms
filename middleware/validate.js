const { ZodError } = require('zod');

/**
 * Middleware factory for Zod schema validation.
 * @param {ZodSchema} schema - The Zod schema to validate against
 * @param {string} source - 'body', 'query', or 'params' (default 'body')
 */
const validate = (schema, source = 'body') => {
  return (req, res, next) => {
    try {
      const data = req[source];
      const parsed = schema.parse(data);
      req[source] = parsed; // replace with validated data
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }));
        return res.status(400).json({ errors });
      }
      next(error);
    }
  };
};

module.exports = validate;