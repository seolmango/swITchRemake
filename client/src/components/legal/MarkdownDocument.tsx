import React from 'react';

interface ListItem {
    text: string;
    children: React.ReactNode[];
}

const inlinePattern = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/gu;

const renderInline = (text: string): React.ReactNode[] => text.split(inlinePattern).filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    if (/^https?:\/\//u.test(part)) return <a key={index} href={part} target="_blank" rel="noreferrer">{part}</a>;
    if (/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/u.test(part)) return <a key={index} href={`mailto:${part}`}>{part}</a>;
    return <React.Fragment key={index}>{part}</React.Fragment>;
});

const listMarker = /^(\s*)([-*]|\d+\.)\s+(.+)$/u;
const tableCells = (line: string) => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());
const isTableDivider = (line: string) => {
    const cells = tableCells(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
};
const isBlockStart = (lines: string[], index: number) => {
    const line = lines[index] ?? '';
    return /^#{1,6}\s+/u.test(line)
        || /^\s*---+\s*$/u.test(line)
        || listMarker.test(line)
        || (line.includes('|') && isTableDivider(lines[index + 1] ?? ''));
};

const parseList = (lines: string[], start: number, key: string): { node: React.ReactNode; next: number } => {
    const first = lines[start]!.match(listMarker)!;
    const baseIndent = first[1]!.length;
    const ordered = first[2]!.endsWith('.');
    const items: ListItem[] = [];
    let index = start;

    while (index < lines.length) {
        const line = lines[index]!;
        if (!line.trim()) break;
        const match = line.match(listMarker);
        if (match) {
            const indent = match[1]!.length;
            if (indent < baseIndent) break;
            if (indent > baseIndent) {
                if (items.length === 0) break;
                const nested = parseList(lines, index, `${key}-nested-${items.length}`);
                items.at(-1)!.children.push(nested.node);
                index = nested.next;
                continue;
            }
            if (match[2]!.endsWith('.') !== ordered) break;
            items.push({ text: match[3]!, children: [] });
            index += 1;
            continue;
        }
        if (items.length === 0 || isBlockStart(lines, index)) break;
        items.at(-1)!.text += ` ${line.trim()}`;
        index += 1;
    }

    const Tag = ordered ? 'ol' : 'ul';
    return {
        node: (
            <Tag key={key}>
                {items.map((item, itemIndex) => (
                    <li key={`${key}-${itemIndex}`}>
                        <span>{renderInline(item.text)}</span>
                        {item.children}
                    </li>
                ))}
            </Tag>
        ),
        next: index,
    };
};

/** 번들에 포함된 법률 Markdown을 내용 변경 없이 읽기 좋은 HTML 구조로 옮긴다. */
export const MarkdownDocument: React.FC<{ source: string }> = ({ source }) => {
    const lines = source.replace(/\r\n?/gu, '\n').split('\n');
    const blocks: React.ReactNode[] = [];
    let index = 0;

    while (index < lines.length) {
        const line = lines[index]!;
        if (!line.trim()) {
            index += 1;
            continue;
        }

        const heading = line.match(/^(#{1,6})\s+(.+)$/u);
        if (heading) {
            const level = Math.min(6, heading[1]!.length + 2);
            blocks.push(React.createElement(`h${level}`, { key: `heading-${index}` }, renderInline(heading[2]!)));
            index += 1;
            continue;
        }

        if (/^\s*---+\s*$/u.test(line)) {
            blocks.push(<hr key={`rule-${index}`}/>);
            index += 1;
            continue;
        }

        if (line.includes('|') && isTableDivider(lines[index + 1] ?? '')) {
            const header = tableCells(line);
            const rows: string[][] = [];
            index += 2;
            while (index < lines.length && lines[index]!.trim() && lines[index]!.includes('|')) {
                rows.push(tableCells(lines[index]!));
                index += 1;
            }
            blocks.push(
                <div className="legal-table-wrap" tabIndex={0} key={`table-${index}`}>
                    <table>
                        <thead><tr>{header.map((cell, cellIndex) => <th scope="col" key={cellIndex}>{renderInline(cell)}</th>)}</tr></thead>
                        <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{renderInline(cell)}</td>)}</tr>)}</tbody>
                    </table>
                </div>,
            );
            continue;
        }

        if (listMarker.test(line)) {
            const list = parseList(lines, index, `list-${index}`);
            blocks.push(list.node);
            index = list.next;
            continue;
        }

        const paragraph: string[] = [];
        while (index < lines.length && lines[index]!.trim() && !isBlockStart(lines, index)) {
            paragraph.push(lines[index]!.trim());
            index += 1;
        }
        blocks.push(<p key={`paragraph-${index}`}>{renderInline(paragraph.join(' '))}</p>);
    }

    return <div className="legal-document-source" tabIndex={0}>{blocks}</div>;
};
