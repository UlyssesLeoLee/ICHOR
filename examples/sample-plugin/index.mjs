/**
 * ATS-512 sample plugin: a runner that reports what it can do.
 *
 * This is the **协议样例** (protocol sample) of ATS-512. It shows the whole
 * shape a plugin author has to deal with:
 *
 *   1. the manifest declares what the plugin wants (examples/sample-plugin/
 *      manifest.json) -- the HOST decides what is actually granted;
 *   2. the plugin receives the SDK from the host and uses only the declared
 *      surface;
 *   3. every call the plugin makes is audited by the host;
 *   4. the host binds the scope AND the projects, and holds the authoritative
 *      proposal record -- the plugin never sees any of them.
 *
 * **This is a protocol sample, not a runnable plugin.** There is no plugin
 * host, no loader and no sandbox in this repository, so `export default` here
 * is a function the host would CALL, not an entry point anything executes by
 * itself. It does NOT run by itself. The sample is exercised by the probe in
 * tools/ats512-probes/, which plays the role of the host and shows that the
 * plugin cannot exceed its declared permissions.
 *
 * A plugin author writes exactly this shape:
 *
 *   export default {
 *     async run(sdk, context) {
 *       const described = sdk.describe();       // what am I allowed to do?
 *       const spec = await sdk.readTestFile(context.projectId, 'tests/login.spec.ts');
 *       return { summary: `read ${spec.file}`, ... };
 *     },
 *   };
 */
export default {
  /**
   * @param {object} sdk       the host-provided SDK (see server/plugins/sdk.mjs)
   * @param {object} context   { projectId, scope }
   */
  async run(sdk, context) {
    // describe() needs no permission and tells the plugin exactly what the
    // host granted it -- so a plugin never has to guess.
    const described = sdk.describe();

    // The plugin asks for what it declared; if the host did not grant it,
    // the SDK raises PLUGIN_PERMISSION_DENIED and the refusal is audited.
    const files = [];
    for (const file of context.files ?? []) {
      try {
        const spec = await sdk.readTestFile(context.projectId, file);
        files.push({ file: spec.file, hash: spec.hash });
      } catch (error) {
        // A plugin that swallows the refusal would defeat the audit trail,
        // so the refusal is re-thrown with its code intact.
        throw error;
      }
    }

    return {
      pluginId: described.pluginId,
      tier: described.tier,
      grantedPermissions: described.grantedPermissions,
      files,
    };
  },
};
