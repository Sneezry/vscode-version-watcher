import * as fs from 'fs-plus';
import * as request from 'request-promise';
import * as https from 'https';

interface Tag {
  name: string;
}

interface VSCode {
  vscode: string;
  electron: string|undefined;
  node: string|undefined;
  chrome: string|undefined;
}

interface Issue {
  html_url: string,
  title: string,
  body: string,
  created_at: string,
  updated_at: string,
  user: {
    login: string,
    html_url: string
  }
}

const VERSION = require('../version.json') as VSCode[];

let tweet = '#VSCodeWatcher ';

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
  const tags: string[] = ['master'];
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
  const nodeVersionHeaderFile = await request(
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

async function getIssues() {
  const issueUri = 'https://api.github.com/search/issues?q=is%3Aissue+archived%3Afalse+label%3Aelectron-update+is%3Aopen';
  const issueApiRes = await request({uri: issueUri, headers: {'User-Agent': 'VSCode Version Watcher'}, json: true}) as {items: Issue[]};
  const issueList = issueApiRes.items;
  let md = '\n\n## Open Issue About Electron Update\n\n| Title | Creator | Create | Update |\n| :---:| :-----: | :----: | :----: |\n';
  for (let issue of issueList) {
    md += `| [${issue.title}](${issue.html_url}) | [${issue.user.login}](${issue.user.html_url}) | ${issue.created_at} | ${issue.updated_at}|\n`;
  }

  tweet += `${issueList.length} open issue(s) about Electron update. `
  return md;
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
      vscode: version === 'master' ? 'Latest' : version,
      electron: electronVersion,
      chrome: chromeVersion,
      node: nodeVersion
    };

    versionList.push(tag);
  }

  return versionList.concat(VERSION);
}

async function saveToFile(list: VSCode[]) {
  let md = `# VSCode Version Watcher\n\nFollow on Twitter [@VscodeW](https://twitter.com/VscodeW)!\n\n`;
  let alertLevel = 0;

  if (list.length > 1) {
    if (list[0].electron && list[1].electron) {
      const ev1 = (list[0].electron as string).split('.');
      const ev2 = (list[1].electron as string).split('.');
      if (ev1[0] > ev2[0] || ev1[1] && ev2[1] && ev1[1] > ev2[1]) {
        alertLevel = 2;
      }

      const nv1 = (list[0].node as string).split('.');
      const nv2 = (list[1].node as string).split('.');
      if (nv1[0] > nv2[0] || nv1[1] && nv2[1] && nv1[1] > nv2[1]) {
        alertLevel = 2;
      }

      const cv1 = (list[0].chrome as string).split('.');
      const cv2 = (list[1].chrome as string).split('.');
      if (cv1[0] > cv2[0]) {
        alertLevel = 2;
      }
    }

    if (list.length > 2 && !alertLevel) {
      const ev1 = (list[1].electron as string).split('.');
      const ev2 = (list[2].electron as string).split('.');
      if (ev1[0] > ev2[0] || ev1[1] && ev2[1] && ev1[1] > ev2[1]) {
        alertLevel = 1;
      }

      const nv1 = (list[1].node as string).split('.');
      const nv2 = (list[2].node as string).split('.');
      if (nv1[0] > nv2[0] || nv1[1] && nv2[1] && nv1[1] > nv2[1]) {
        alertLevel = 1;
      }

      const cv1 = (list[1].chrome as string).split('.');
      const cv2 = (list[2].chrome as string).split('.');
      if (cv1[0] > cv2[0]) {
        alertLevel = 1;
      }
    }
  }

  switch (alertLevel) {
    case 0:
      md += `\`\`\`diff\n++ No change in recent release. ++\n\`\`\`\n\n`;
      tweet += 'No change in recent release. ';
      break;
    case 1:
      md += `\`\`\`diff\n@@ Notice: Change in current release. @@\n\`\`\`\n\n`;
      tweet += 'Notice: Change in current release. ';
      break;
    case 2:
      md +=
          `\`\`\`diff\n-- Warning! Change in the next release. --\n\`\`\`\n\n`;
      tweet += 'Warning! Change in the next release. ';
      break;
    default:
      break;
  }

  md += `Last update: ${
      new Date().toISOString().replace(
          /(T|\..*)/g,
          ' ')}GMT\n\n| VS Code | Electron | Node | Chrome |\n|:-------:|:--------:|:----:|:------:|`;
  list.forEach(version => {
    md += `\n| ${version.vscode} | ${version.electron || 'n/a'} | ${
        version.node || 'n/a'} | ${version.chrome || 'n/a'} |`;
  });

  md += await getIssues();
  fs.writeFileSync('README.md', md);
  list.shift();
  fs.writeFileSync('version.json', JSON.stringify(list));
}

async function postTweet() {
  const tweetEndpoint = process.env.TWEET_ENDPOINT;
  if (!tweetEndpoint) {
    console.log('No tweet endpoint found.');
    return;
  }

  const tweetEndpointMatches = tweetEndpoint.match(/:\/\/(.*?):443(.*)/);
  if (!tweetEndpointMatches) {
    console.log('Tweet endpoint does not match the rule.');
    return;
  }

  const hostname = tweetEndpointMatches[1];
  const path = tweetEndpointMatches[2];
  const req = https.request({
    hostname,
    path,
    method: 'POST',
    headers: {
      'Content-Length': tweet.length
    }
  }, res => {
    console.log('Tweet:', tweet);
    console.log('Tweet published.');
    return Promise.resolve();
  });

  req.write(tweet);
  req.end;
  return;
}

async function start() {
  const list = await getVersions();
  await saveToFile(list);
  tweet += 'https://github.com/Sneezry/vscode-version-watcher#vscode-version-watcher';
  await postTweet();
  console.log('Finished!');
}

start();