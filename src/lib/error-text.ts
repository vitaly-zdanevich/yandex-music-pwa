const MAX_DEPTH = 12;
const MAX_PROPERTIES = 100;

interface OwnProperty {
	name: string;
	value: unknown;
}

interface OwnValue {
	found: boolean;
	value?: unknown;
}

export function formatErrorText(value: unknown): string {
	try {
		return formatValue(value, new Set<object>(), 0, true);
	} catch {
		return `[Unable to format ${typeof value}]`;
	}
}

function formatValue(value: unknown, active: Set<object>, depth: number, root: boolean): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'string') return root ? value : quote(value);
	if (typeof value === 'number') return String(value);
	if (typeof value === 'bigint') return `${value.toString()}n`;
	if (typeof value === 'boolean') return String(value);
	if (typeof value === 'symbol') return safeSymbolText(value);
	if (typeof value === 'function') return safeFunctionText(value);
	if (depth >= MAX_DEPTH) return '[Maximum depth reached]';
	if (isError(value)) return formatError(value, active, depth);
	return formatObject(value, active, depth);
}

function formatError(error: Error, active: Set<object>, depth: number): string {
	if (active.has(error)) return '[Circular Error]';
	active.add(error);
	try {
		let output = errorHeading(error);
		const properties = ownProperties(error, new Set(['name', 'message', 'stack', 'cause']), false)
			.filter((property) => property.value !== undefined);
		for (const property of properties) {
			output = appendLine(
				output,
				`${propertyLabel(property.name)}: ${indentContinuation(formatValue(property.value, active, depth + 1, false))}`,
			);
		}

		const cause = ownValue(error, 'cause');
		if (cause.found && cause.value !== undefined) {
			const causeText = formatValue(cause.value, active, depth + 1, true);
			output = appendLine(output, `Caused by:\n${indent(causeText)}`);
		}
		return output;
	} finally {
		active.delete(error);
	}
}

function errorHeading(error: Error): string {
	const stack = safeProperty(error, 'stack');
	if (typeof stack === 'string' && stack.trim()) return stack;
	const name = safeProperty(error, 'name');
	const message = safeProperty(error, 'message');
	const safeName = typeof name === 'string' && name ? name : 'Error';
	return typeof message === 'string' && message ? `${safeName}: ${message}` : safeName;
}

function formatObject(value: object, active: Set<object>, depth: number): string {
	if (active.has(value)) return '[Circular]';
	active.add(value);
	try {
		if (Array.isArray(value)) return formatArray(value, active, depth);
		const properties = ownProperties(value, new Set(), true);
		if (properties.length === 0) return emptyObjectText(value);
		const truncated = properties.length > MAX_PROPERTIES;
		const rendered = properties.slice(0, MAX_PROPERTIES).map((property) => {
			const propertyText = formatValue(property.value, active, depth + 1, false);
			return `\t${quote(property.name)}: ${indentContinuation(propertyText)}`;
		});
		if (truncated) rendered.push(`\t"…": "${properties.length - MAX_PROPERTIES} more properties"`);
		return `{\n${rendered.join(',\n')}\n}`;
	} catch {
		return '[Unserializable object]';
	} finally {
		active.delete(value);
	}
}

function formatArray(value: unknown[], active: Set<object>, depth: number): string {
	const length = Math.min(value.length, MAX_PROPERTIES);
	const rendered: string[] = [];
	for (let index = 0; index < length; index += 1) {
		const item = ownValue(value, String(index));
		const itemText = item.found ? formatValue(item.value, active, depth + 1, false) : '[Empty]';
		rendered.push(indent(itemText));
	}
	if (value.length > MAX_PROPERTIES) rendered.push(`\t"… ${value.length - MAX_PROPERTIES} more items"`);
	return rendered.length > 0 ? `[\n${rendered.join(',\n')}\n]` : '[]';
}

function ownProperties(value: object, excluded: Set<string>, enumerableOnly: boolean): OwnProperty[] {
	const names = Object.getOwnPropertyNames(value);
	const properties: OwnProperty[] = [];
	for (const name of names) {
		if (excluded.has(name)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		if (!descriptor || (enumerableOnly && !descriptor.enumerable)) continue;
		let propertyValue: unknown;
		if ('value' in descriptor) propertyValue = descriptor.value;
		else if (descriptor.get && descriptor.set) propertyValue = '[Getter/Setter]';
		else if (descriptor.get) propertyValue = '[Getter]';
		else propertyValue = '[Setter]';
		properties.push({ name, value: propertyValue });
	}
	return properties;
}

function ownValue(value: object, name: string): OwnValue {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		if (!descriptor) return { found: false };
		if ('value' in descriptor) return { found: true, value: descriptor.value };
		if (descriptor.get && descriptor.set) return { found: true, value: '[Getter/Setter]' };
		if (descriptor.get) return { found: true, value: '[Getter]' };
		return { found: true, value: '[Setter]' };
	} catch {
		return { found: true, value: '[Unreadable property]' };
	}
}

function safeProperty(value: object, name: string): unknown {
	try {
		return Reflect.get(value, name);
	} catch {
		return undefined;
	}
}

function emptyObjectText(value: object): string {
	try {
		const tag = Object.prototype.toString.call(value);
		return tag === '[object Object]' ? '{}' : tag;
	} catch {
		return '{}';
	}
}

function isError(value: object): value is Error {
	try {
		return value instanceof Error;
	} catch {
		return false;
	}
}

function safeFunctionText(value: Function): string {
	try {
		return value.name ? `[Function ${value.name}]` : '[Function]';
	} catch {
		return '[Function]';
	}
}

function safeSymbolText(value: symbol): string {
	try {
		return String(value);
	} catch {
		return '[Symbol]';
	}
}

function propertyLabel(name: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(name) ? name : quote(name);
}

function quote(value: string): string {
	try {
		return JSON.stringify(value) ?? '""';
	} catch {
		return '"[Unserializable string]"';
	}
}

function indent(value: string): string {
	return value.split('\n').map((line) => `\t${line}`).join('\n');
}

function indentContinuation(value: string): string {
	return value.replace(/\n/g, '\n\t');
}

function appendLine(existing: string, line: string): string {
	return `${existing}${existing.endsWith('\n') ? '' : '\n'}${line}`;
}
