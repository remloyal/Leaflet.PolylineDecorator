import resolve from "rollup-plugin-node-resolve";
import babel from "rollup-plugin-babel";
import fs from "fs";
import path from "path";

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
