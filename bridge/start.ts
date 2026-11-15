// Writes the bridge's config from the environment (secrets/couchdb.env and secrets/bridge.env), then runs
// the bridge. The config lives only inside the running container.
//
// The vault's LiveSync settings that must match (from the PC's plugin): end-to-end encryption with
// path obfuscation (same passphrase), an ID key (idDerivationVersion 1), NFC path identity
// (pathNormalizationVersion 1), case-insensitive file names.

function need(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    console.error(`Missing ${name}: see secrets/README.md (bridge.env). Not starting.`);
    Deno.exit(1);
  }
  return value;
}

const fromBase64 = (name: string) => new TextDecoder().decode(
  Uint8Array.from(atob(need(name)), (c) => c.charCodeAt(0)),
).trim();

const passphrase = fromBase64("LIVESYNC_PASSPHRASE_B64");
const shared = { group: "notes", pathNormalizationVersion: 1, handleFilenameCaseSensitive: false };

const config = {
  peers: [
    {
      ...shared,
      type: "couchdb",
      name: "notes-db",
      url: "http://couchdb:5984",
      database: "notes",
      username: need("COUCHDB_USER"),
      password: need("COUCHDB_PASSWORD"),
      passphrase,
      obfuscatePassphrase: passphrase,
      idDerivationKey: fromBase64("LIVESYNC_ID_KEY_B64"),
      baseDir: "",
      useRemoteTweaks: true,
    },
    {
      ...shared,
      type: "storage",
      name: "notes-files",
      baseDir: "./data/vault/",
      scanOfflineChanges: true,
      // Editors' and tools' scratch files never go up to the vault.
      ignore: ["**/.git/**", "**/*.tmp", "**/*.swp", "**/~*"],
    },
  ],
};

await Deno.writeTextFile("/app/dat/config.json", JSON.stringify(config, null, 2), { mode: 0o600 });

const bridge = new Deno.Command("deno", { args: ["run", "-A", "main.ts", ...Deno.args] }).spawn();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  Deno.addSignalListener(signal, () => bridge.kill(signal));
}
Deno.exit((await bridge.status).code);
