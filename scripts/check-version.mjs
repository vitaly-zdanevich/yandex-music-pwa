import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ZERO_SHA = /^0+$/;

function git(...args) {
	return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function fileAt(revision, path) {
	return git('show', `${revision}:${path}`);
}

function parseVersion(value, source) {
	const match = SEMVER.exec(value);
	if (!match) {
		throw new Error(`${source} must contain a stable major.minor.patch version; found ${value}`);
	}
	return match.slice(1).map(Number);
}

function isGreater(current, previous) {
	for (let index = 0; index < current.length; index += 1) {
		if (current[index] !== previous[index]) return current[index] > previous[index];
	}
	return false;
}

function snapshot(read) {
	const packageJson = JSON.parse(read('package.json'));
	const packageLock = JSON.parse(read('package-lock.json'));
	const cargo = read('proxy/Cargo.toml');
	const cargoLock = read('proxy/Cargo.lock');
	const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
	const cargoLockVersion = /\[\[package\]\]\s+name\s*=\s*"yandex-music-proxy"\s+version\s*=\s*"([^"]+)"/m
		.exec(cargoLock)?.[1];
	return {
		version: packageJson.version,
		lockVersion: packageLock.version,
		lockPackageVersion: packageLock.packages?.['']?.version,
		cargoVersion,
		cargoLockVersion,
	};
}

function validateSnapshot(current, label) {
	parseVersion(current.version, `${label} package.json`);
	for (const [source, version] of [
		['package-lock.json', current.lockVersion],
		['package-lock.json root package', current.lockPackageVersion],
		['proxy/Cargo.toml', current.cargoVersion],
		['proxy/Cargo.lock', current.cargoLockVersion],
	]) {
		if (version !== current.version) {
			throw new Error(`${label} ${source} version ${String(version)} does not match ${current.version}`);
		}
	}
}

function validateIncrement(current, previous, label) {
	validateSnapshot(current, label);
	validateSnapshot(previous, `${label} parent`);
	const currentParts = parseVersion(current.version, `${label} package.json`);
	const previousParts = parseVersion(previous.version, `${label} parent package.json`);
	if (!isGreater(currentParts, previousParts)) {
		throw new Error(
			`${label} must increment the version above ${previous.version}; found ${current.version}`,
		);
	}
}

function commitExists(revision) {
	try {
		git('cat-file', '-e', `${revision}^{commit}`);
		return true;
	} catch {
		return false;
	}
}

function isAncestor(ancestor, descendant) {
	try {
		git('merge-base', '--is-ancestor', ancestor, descendant);
		return true;
	} catch {
		return false;
	}
}

function resolveRemoteBase(baseRef) {
	for (const candidate of [`refs/remotes/origin/${baseRef}`, `origin/${baseRef}`, baseRef]) {
		if (commitExists(candidate)) return git('rev-parse', candidate);
	}
	throw new Error(`Could not resolve the current base branch ${baseRef}`);
}

function validateCommitRange(rangeBase, head) {
	const commits = git('rev-list', '--reverse', `${rangeBase}..${head}`)
		.split('\n')
		.filter(Boolean);
	for (const commit of commits) {
		const parent = git('rev-list', '--parents', '-n', '1', commit).split(' ')[1];
		if (!parent) {
			validateSnapshot(snapshot((path) => fileAt(commit, path)), commit.slice(0, 7));
			continue;
		}
		validateIncrement(
			snapshot((path) => fileAt(commit, path)),
			snapshot((path) => fileAt(parent, path)),
			commit.slice(0, 7),
		);
	}
	return commits.length;
}

function validateHeadAgainstBase(head, base, label) {
	if (head === base) return;
	validateIncrement(
		snapshot((path) => fileAt(head, path)),
		snapshot((path) => fileAt(base, path)),
		label,
	);
}

const eventName = process.env.VERSION_EVENT_NAME;
const eventBase = process.env.VERSION_BASE_SHA;
const head = process.env.VERSION_HEAD_SHA;
const baseRef = process.env.VERSION_BASE_REF;

if (eventBase && head) {
	if (!commitExists(head)) throw new Error(`Could not resolve version-check head ${head}`);
	let rangeBase;
	let comparisonBase;

	if (eventName === 'pull_request' || ZERO_SHA.test(eventBase)) {
		if (!baseRef) throw new Error('VERSION_BASE_REF is required for pull requests and new branches');
		comparisonBase = resolveRemoteBase(baseRef);
		rangeBase = git('merge-base', comparisonBase, head);
	} else {
		if (!commitExists(eventBase)) {
			throw new Error(
				`Could not resolve pushed base ${eventBase}; fetch that commit before checking a force push`,
			);
		}
		if (isAncestor(eventBase, head)) {
			rangeBase = eventBase;
		} else {
			rangeBase = git('merge-base', eventBase, head);
			comparisonBase = eventBase;
		}
	}

	const count = validateCommitRange(rangeBase, head);
	if (comparisonBase) {
		validateHeadAgainstBase(
			head,
			comparisonBase,
			eventName === 'pull_request' ? 'Pull request result' : 'Rewritten push result',
		);
	}
	console.log(`Validated semantic version increments for ${count} commit(s).`);
} else {
	validateIncrement(
		snapshot((path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')),
		snapshot((path) => fileAt('HEAD', path)),
		'Working tree',
	);
	console.log('Working-tree version increment is valid.');
}
