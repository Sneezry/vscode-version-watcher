import * as fs from 'fs-plus';
import * as request from 'request-promise';

interface Tag {
  name: string;
}

interface VSCode {
  vscode: string;
  electron: string|undefined;
  node: string|undefined;
  chrome: string|undefined;
}

const VERSION = require('../version.json') as VSCode[];

async function githubRequest<T>(uri: string): Promise<T[]> {
  const result = [];
  return await request({
    uri,
    headers: {'User-Agent': 'VSCode Version Watcher'},
    json: true,
    transform: async (body, response, resolveWithFullResponse) => {
      if (response.headers['link'] !== undefined) {
        const link = response.headers['link'] as string;
        const linkAttr = link.split(',');
        for (const attr of linkAttr) {
          const urlMatches = attr.match(/^\s*<(.*)>;\s*rel="(.*)"\s*$/);
          if (urlMatches && urlMatches.length > 2) {
            if (urlMatches[2] === 'next') {
              const res = await githubRequest<T>(urlMatches[1]);
              return [body].concat(res) as T[];
            }
          }
        }
      }
      return [body];
    }
  });
}

async function fetchVSCodeVersion() {
  const uri = `https://api.github.com/repos/Microsoft/vscode/tags?client_id=${
      process.env.GITHUB_CLIENT_ID}&client_secret=${
      process.env.GITHUB_CLIENT_SECRET}`;
  const tags: string[] = [];
  const res = await githubRequest<Tag[]>(uri);
  res.forEach(list => {
    list.forEach(tag => {
      if (/^\d+\.\d+\.\d+(\-insiders)?$/.test(tag.name)) {
        tags.push(tag.name);
      }
    });
  });
  return tags;
}

async function getElectron(vscodeVersion: string) {
  const uri = `https://raw.githubusercontent.com/Microsoft/vscode/${
      vscodeVersion}/package.json?client_id=${
      process.env.GITHUB_CLIENT_ID}&client_secret=${
      process.env.GITHUB_CLIENT_SECRET}`;
  const pkg = await request(
      {uri, headers: {'User-Agent': 'VSCode Version Watcher'}, json: true});

  let electronVersion = pkg.electronVersion as string;

  if (!electronVersion) {
    const uri = `https://raw.githubusercontent.com/Microsoft/vscode/${
        vscodeVersion}/.yarnrc?client_id=${
        process.env.GITHUB_CLIENT_ID}&client_secret=${
        process.env.GITHUB_CLIENT_SECRET}`;
    const yarnc = await request(
        {uri, headers: {'User-Agent': 'VSCode Version Watcher'}, json: true});
    const targetMatches = yarnc.match(/target "(.*?)"/);
    if (targetMatches && targetMatches.length > 1) {
      electronVersion = targetMatches[1];
    }
  }

  return electronVersion;
}

async function getChromeVersion(electronVersion: string) {
  const uri = `https://raw.githubusercontent.com/electron/electron/v${
      electronVersion}/atom/common/chrome_version.h?client_id=${
      process.env.GITHUB_CLIENT_ID}&client_secret=${
      process.env.GITHUB_CLIENT_SECRET}`;
  const chromeVersionHeaderFile =
      await request({uri, headers: {'User-Agent': 'VSCode Version Watcher'}});
  const versionMatches =
      chromeVersionHeaderFile.match(/CHROME_VERSION_STRING "(.*?)"/);
  let chromeVersion: string|undefined = undefined;
  if (versionMatches && versionMatches.length > 1) {
    chromeVersion = versionMatches[1] as string;
  }
  return chromeVersion;
}

async function getNodeVersion(electronVersion: string) {
  const uri =
      `https://api.github.com/repos/electron/electron/contents/vendor/node?ref=v${
          electronVersion}&client_id=${
          process.env.GITHUB_CLIENT_ID}&client_secret=${
          process.env.GITHUB_CLIENT_SECRET}`;
  const nodeSubModule = await request(
      {uri, headers: {'User-Agent': 'VSCode Version Watcher'}, json: true});
  const nodeSha = nodeSubModule.sha;
  if (!nodeSha) {
    return undefined;
  }
  const nodeVersionUri = `https://raw.githubusercontent.com/electron/node/${
      nodeSha}/src/node_version.h?client_id=${
      process.env.GITHUB_CLIENT_ID}&client_secret=${
      process.env.GITHUB_CLIENT_SECRET}`;
  const nodeVersionHeaderFile = await await request(
      {uri: nodeVersionUri, headers: {'User-Agent': 'VSCode Version Watcher'}});
  const nodeMajorVersionMatches =
      nodeVersionHeaderFile.match(/NODE_MAJOR_VERSION (\d+)/);
  const nodeMinorVersionMatches =
      nodeVersionHeaderFile.match(/NODE_MINOR_VERSION (\d+)/);
  const nodePatchVersionMatches =
      nodeVersionHeaderFile.match(/NODE_PATCH_VERSION (\d+)/);
  if (nodeMajorVersionMatches && nodeMajorVersionMatches.length > 1 &&
      nodeMinorVersionMatches && nodeMinorVersionMatches.length > 1 &&
      nodePatchVersionMatches && nodePatchVersionMatches.length > 1) {
    return `${nodeMajorVersionMatches[1]}.${nodeMinorVersionMatches[1]}.${
        nodePatchVersionMatches[1]}`;
  }
  return undefined;
}

async function getVersions() {
  const vscodeVersions = await fetchVSCodeVersion();
  const versionList: VSCode[] = [];

  const cachedVSersions: string[] = [];
  VERSION.forEach(v => {
    cachedVSersions.push(v.vscode);
  });

  for (const version of vscodeVersions) {
    if (cachedVSersions.indexOf(version) >= 0) {
      continue;
    }

    console.log(`Fetching ${version}...`);
    const electronVersion = await getElectron(version);
    const chromeVersion = await getChromeVersion(electronVersion);
    const nodeVersion = await getNodeVersion(electronVersion);

    const tag: VSCode = {
      vscode: version,
      electron: electronVersion,
      chrome: chromeVersion,
      node: nodeVersion
    };

    versionList.push(tag);
  }

  return versionList.concat(VERSION);
}

function saveToFile(list: VSCode[]) {
  let md =
      `| VS Code | Electron | Node | Chrome |\n|:-------:|:--------:|:----:|:------:|`;
  list.forEach(version => {
    md += `\n| ${version.vscode} | ${version.electron || 'n/a'} | ${
        version.node || 'n/a'} | ${version.chrome || 'n/a'} |`;
  });
  fs.writeFileSync('README.md', md);
  fs.writeFileSync('version.json', JSON.stringify(list));
}

async function start() {
  const list = await getVersions();
  saveToFile(list);
  console.log('Finished!');
}

start();