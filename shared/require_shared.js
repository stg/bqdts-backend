const path = require("path");
const fs = require("fs");
const { createRequire } = require("module");

let cachedRequire = null;

function findElectronPackageJson() {
  if (!process.versions || !process.versions.electron) return null;
  const devResourcesMarker = path.join("node_modules", "electron", "dist", "resources");
  const isDevResources = process.resourcesPath && process.resourcesPath.includes(devResourcesMarker);
  if (isDevResources) {
    return path.join(__dirname, "..", "..", "electron", "package.json");
  }
  const asarPath = path.join(process.resourcesPath, "app.asar", "package.json");
  if (fs.existsSync(asarPath)) return asarPath;
  const appPath = path.join(process.resourcesPath, "app", "package.json");
  if (fs.existsSync(appPath)) return appPath;
  const fallback = path.join(process.resourcesPath, "backend", "electron", "package.json");
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

function getSharedRequire() {
  if (cachedRequire) return cachedRequire;
  const pkg = findElectronPackageJson();
  cachedRequire = pkg ? createRequire(pkg) : require;
  return cachedRequire;
}

function sharedRequire(moduleName) {
  return getSharedRequire()(moduleName);
}

module.exports = { getSharedRequire, sharedRequire };
