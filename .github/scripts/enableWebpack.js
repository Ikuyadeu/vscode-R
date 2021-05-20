"use strict";
exports.__esModule = true;
var fs = require("fs");
// adjust .vscodeignore
var fileVscodeignore = './.vscodeignore';
var vscodeignore = fs.readFileSync(fileVscodeignore, 'utf-8');
vscodeignore = vscodeignore.replace(/^# *(.*)# *withWebpack *$/gm, '$1');
fs.writeFileSync(fileVscodeignore, vscodeignore);
// adjust package.json
var filePkgJson = './package.json';
var pkgJson = JSON.parse(fs.readFileSync(filePkgJson, 'utf-8'));
if ('withWebpack' in pkgJson) {
    for (var k in pkgJson.withWebpack) {
        pkgJson[k] = pkgJson.withWebpack[k];
    }
    pkgJson.withWebpack = undefined;
}
fs.writeFileSync(filePkgJson, JSON.stringify(pkgJson, undefined, 2));