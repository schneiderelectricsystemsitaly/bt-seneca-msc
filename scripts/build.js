"use strict";

const { buildSync } = require("esbuild");
const path = require("node:path");

const minify = process.argv.includes("--minify");

buildSync({
    absWorkingDir: path.resolve(__dirname, ".."),
    entryPoints: ["meterApi.js"],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "MSC",
    target: "es2021",
    minify,
    sourcemap: minify ? "linked" : "inline",
    outfile: `dist/bt-seneca-msc${minify ? ".min" : ""}.js`,
    footer: {
        js: 'if (typeof module === "object" && module.exports) module.exports = MSC; else if (typeof define === "function" && define.amd) define([], function () { return MSC; });',
    },
});
