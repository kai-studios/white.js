import { ValidationError } from './errors.js';

// Validates params, query and body with any schema that has .safeParse()
// (zod and compatible libraries). Parsed values are available as req.valid.
//
//   router.post('/', validate({ body: z.object({ name: z.string() }) }), handler)
export function validate(schemas) {
  return (req, res, next) => {
    const issues = [];
    req.valid = {};
    for (const key of ['params', 'query', 'body']) {
      const schema = schemas[key];
      if (!schema) continue;
      const result = schema.safeParse(req[key]);
      if (result.success) {
        req.valid[key] = result.data;
      } else {
        for (const issue of result.error?.issues ?? [{ message: 'Invalid value' }]) {
          issues.push({ in: key, path: (issue.path ?? []).join('.'), message: issue.message });
        }
      }
    }
    next(issues.length ? new ValidationError(issues) : undefined);
  };
}
