import "./preload.ts";

const result = await Bun.build({
  entrypoints: ["./nanoboss.ts"],
  compile: {
    outfile: "./dist/nanoboss",
    autoloadBunfig: true,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exitCode = 1;
}
