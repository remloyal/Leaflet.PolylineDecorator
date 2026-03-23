import resolve from "rollup-plugin-node-resolve";
import babel from "rollup-plugin-babel";
import fs from "fs";
import path from "path";

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
);
const repoPath = typeof pkg.repository === "string" ? pkg.repository : "";
const repoUrl = repoPath
  ? `https://github.com/${repoPath.replace(/^github:/, "")}`
  : "";
const homepageUrl = pkg.homepage || repoUrl;
const banner = `/*!\n * ${pkg.name} v${pkg.version}\n * ${homepageUrl || ""}\n * (c) ${new Date().getFullYear()} ${pkg.author || ""}\n * Released under the ${pkg.license || ""} License.\n */`;

function copyTypesPlugin() {
  return {
    name: "copy-types",
    ongenerate() {
      const srcTypeFile = path.resolve(process.cwd(), "src/index.d.ts");
      const distTypeFile = path.resolve(process.cwd(), "dist/index.d.ts");
      fs.copyFileSync(srcTypeFile, distTypeFile);
    },
  };
}

export default {
  entry: "src/L.PolylineDecorator.js",
  dest: "dist/leaflet.polylineDecorator.js",
  format: "umd",
  banner,
  external: ["leaflet"],
  globals: {
    leaflet: "L",
  },
  plugins: [
    resolve(),
    babel({
      babelrc: false,
      exclude: "node_modules/**",
      presets: ["es2015-rollup"],
      plugins: ["external-helpers"],
    }),
    copyTypesPlugin(),
  ],
};
