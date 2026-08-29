import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { closeMail } from './mail';

/**
 * 마지막에 결과만 보여 주는 리포터.
 *
 * 기본 리포터는 도는 동안 계속 찍는다. 이 점검은 몇 분이 걸리고 그동안의 출력은 아무도 안 보므로,
 * 도는 중에는 한 줄짜리 진행 표시만 하고 **끝에 표 하나**를 낸다. 실패한 흐름만 이유를 붙인다.
 */

interface Row {
    file: string;
    title: string;
    status: TestResult['status'];
    durationMs: number;
    error: string | null;
}

const GREEN = '[32m';
const RED = '[31m';
const YELLOW = '[33m';
const DIM = '[2m';
const BOLD = '[1m';
const RESET = '[0m';

/** 흐름 묶음의 사람이 읽는 이름. 파일 이름은 순서를 위한 것이지 읽으라고 있는 게 아니다. */
const GROUP_NAMES: Record<string, string> = {
    'first-visit': '첫 방문과 게스트',
    account: '가입 · 로그인 · 로그아웃',
    password: '비밀번호 찾기와 변경',
    profile: '프로필 · 전적 · 로그인 기기',
    rooms: '방 만들기 · 목록 · 코드 참가',
    lobby: '대기실',
    match: '경기 · 도중 이탈 · 결과',
    training: '훈련장',
    settings: '설정 · 도움말',
    admin: '운영자 화면',
    'account-delete': '탈퇴',
};

export default class SummaryReporter implements Reporter {
    private readonly rows: Row[] = [];
    private total = 0;
    private done = 0;
    private startedAt = 0;

    onBegin(_config: FullConfig, suite: Suite): void {
        this.total = suite.allTests().length;
        this.startedAt = Date.now();
        process.stdout.write(`${BOLD}swITch 사용자 흐름 점검${RESET} — ${this.total}개\n`);
    }

    onTestEnd(test: TestCase, result: TestResult): void {
        this.done += 1;
        this.rows.push({
            file: groupOf(test),
            title: test.title,
            status: result.status,
            durationMs: result.duration,
            error: result.status === 'passed' || result.status === 'skipped'
                ? null
                : firstLine(result.error?.message ?? result.error?.stack ?? '이유 없음'),
        });
        const mark = result.status === 'passed' ? `${GREEN}·${RESET}`
            : result.status === 'skipped' ? `${YELLOW}·${RESET}` : `${RED}x${RESET}`;
        process.stdout.write(`${mark}${this.done === this.total ? '\n' : ''}`);
    }

    async onEnd(result: FullResult): Promise<void> {
        // Redis 연결을 안 닫으면 프로세스가 안 끝난다.
        await closeMail();

        const width = Math.max(...this.rows.map((row) => visibleWidth(row.title)), 20);
        const lines: string[] = ['', `${BOLD}결과${RESET}`, ''];
        let lastGroup = '';
        for (const row of this.rows) {
            if (row.file !== lastGroup) {
                lastGroup = row.file;
                lines.push(`  ${BOLD}${GROUP_NAMES[row.file] ?? row.file}${RESET}`);
            }
            const mark = row.status === 'passed' ? `${GREEN}통과${RESET}`
                : row.status === 'skipped' ? `${YELLOW}건너뜀${RESET}` : `${RED}실패${RESET}`;
            const pad = ' '.repeat(Math.max(0, width - visibleWidth(row.title)));
            lines.push(`    ${row.title}${pad}  ${mark}  ${DIM}${seconds(row.durationMs)}${RESET}`);
        }

        const failed = this.rows.filter((row) => row.error !== null);
        if (failed.length > 0) {
            lines.push('', `${BOLD}${RED}실패한 흐름${RESET}`, '');
            for (const row of failed) {
                lines.push(`  ${RED}✗${RESET} ${GROUP_NAMES[row.file] ?? row.file} · ${row.title}`);
                lines.push(`    ${DIM}${row.error}${RESET}`);
            }
            lines.push('', `  ${DIM}화면·트레이스: npm run e2e:report${RESET}`);
        }

        const passed = this.rows.filter((row) => row.status === 'passed').length;
        const skipped = this.rows.filter((row) => row.status === 'skipped').length;
        lines.push('', [
            `${BOLD}${this.rows.length}개 중 ${passed}개 통과${RESET}`,
            failed.length > 0 ? `${RED}${failed.length}개 실패${RESET}` : null,
            skipped > 0 ? `${YELLOW}${skipped}개 건너뜀${RESET}` : null,
            `${DIM}${seconds(Date.now() - this.startedAt)}${RESET}`,
        ].filter(Boolean).join('  ·  '), '');

        if (result.status === 'passed') lines.push(`${GREEN}사용자가 할 수 있는 모든 흐름이 살아 있습니다.${RESET}`, '');
        process.stdout.write(lines.join('\n'));
    }
}

/** `03-account.spec.ts` -> `account`. 앞의 숫자는 실행 순서를 정하려고 붙인 것뿐이다. */
function groupOf(test: TestCase): string {
    const file = test.location.file.replace(/\\/g, '/').split('/').pop() ?? '';
    return file.replace(/^\d+-/, '').replace(/\.spec\.ts$/, '');
}

function firstLine(message: string): string {
    // eslint-disable-next-line no-control-regex -- Playwright의 오류 문구에는 색 코드가 섞여 있다.
    const clean = message.replace(/[[0-9;]*m/g, '').trim();
    return clean.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '이유 없음';
}

function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

/** 한글은 두 칸을 차지한다. 폭을 글자 수로 세면 표가 어긋난다. */
function visibleWidth(text: string): number {
    let width = 0;
    for (const char of text) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(char) ? 2 : 1;
    return width;
}
