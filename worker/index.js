/** Static-only entry. All financial data remains in browser IndexedDB. */
export default {
  fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
