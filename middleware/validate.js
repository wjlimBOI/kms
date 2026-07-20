const { ZodError } = require('zod');

const validate = (schema, source = 'body') => {
  return (req, res, next) => {
    try {
      const data = req[source];
      const parsed = schema.parse(data);
      req[source] = parsed;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }));
        return res.status(400).json({ 
          error: 'Validation failed',
          code: 'VALIDATION_ERROR',
          errors 
        });
      }
      next(error);
    }
  };
};

module.exports = validate;