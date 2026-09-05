import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HUD_DIR = fileURLToPath(new URL('.', import.meta.url));
const GAME_PAGE = fileURLToPath(new URL('../../pages/GamePage.tsx', import.meta.url));
const REPLAY_PAGE = fileURLToPath(new URL('../../pages/ReplayPage.tsx', import.meta.url));

const sourceFile = (file: string) => ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
);

const tsxFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [path] : [];
});

const TEXT_LITERAL_KINDS = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.JsxText,
]);

const hangulLiterals = (file: string): string[] => {
    const source = sourceFile(file);
    const matches: string[] = [];
    const visit = (node: ts.Node) => {
        if (TEXT_LITERAL_KINDS.has(node.kind) && /[가-힣]/.test(node.getText(source))) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            matches.push(`${file}:${line + 1}: ${node.getText(source)}`);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return matches;
};

const switchGameElements = (file: string) => {
    const source = sourceFile(file);
    const elements: Array<{ source: ts.SourceFile; node: ts.JsxOpeningLikeElement }> = [];
    const visit = (node: ts.Node) => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === 'SwitchGame') {
            elements.push({ source, node });
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return elements;
};

const landscapeAttribute = ({ source, node }: { source: ts.SourceFile; node: ts.JsxOpeningLikeElement }) =>
    node.attributes.properties.find((attribute) =>
        ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'suggestLandscape');

describe('in-game presentation', () => {
    it('keeps Korean display strings out of HUD component source', () => {
        expect(tsxFiles(HUD_DIR).flatMap(hangulLiterals)).toEqual([]);
    });

    it('suggests landscape for every live game, including training, but not replay', () => {
        const liveGames = switchGameElements(GAME_PAGE);
        expect(liveGames).toHaveLength(1);
        const liveLandscape = landscapeAttribute(liveGames[0]!);
        expect(liveLandscape).toBeDefined();
        expect(liveLandscape?.initializer).toBeUndefined();

        const replays = switchGameElements(REPLAY_PAGE);
        expect(replays).toHaveLength(1);
        expect(landscapeAttribute(replays[0]!)).toBeUndefined();
    });
});
