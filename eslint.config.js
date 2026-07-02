import tseslint from 'typescript-eslint';
import base from './eslint.base.mjs';

export default tseslint.config(
  // Org base — byte-identical copy of nanohype library/config/eslint.base.mjs
  // (this repo is standalone-cloneable, so the copy is refreshed by hand from
  // that source rather than drift-gated against a sibling checkout).
  ...base,
  {
    rules: {
      'no-useless-assignment': 'off',
    },
  },
);
