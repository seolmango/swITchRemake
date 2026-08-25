import type { MatchResultSnapshot } from '../api/matches.ts';
import { Color } from '../theme/color.ts';
import { matchResultWinners } from './matchResultWinners.ts';

const roundRect = (context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number, fill: string, stroke?: string) => {
    context.beginPath();
    context.roundRect(x, y, width, height, radius);
    context.fillStyle = fill;
    context.fill();
    if (stroke) {
        context.lineWidth = 5;
        context.strokeStyle = stroke;
        context.stroke();
    }
};

const drawText = (context: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, weight: 500 | 700 = 500, align: CanvasTextAlign = 'left') => {
    context.font = `${weight} ${size}px "Gmarket Sans", sans-serif`;
    context.fillStyle = Color.black;
    context.textAlign = align;
    context.textBaseline = 'middle';
    context.fillText(text, x, y);
};

export async function createResultImage(result: MatchResultSnapshot, labels: {
    title: string;
    winner: string;
    noWinner: string;
    noWinnerDetail: string;
    victory: string;
    map: string;
    duration: string;
    player: string;
    switchRate: string;
    tags: string;
    you: string;
}): Promise<Blob> {
    await document.fonts?.ready;

    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1350;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('CANVAS_UNAVAILABLE');

    context.fillStyle = Color.white;
    context.fillRect(0, 0, canvas.width, canvas.height);

    roundRect(context, 50, 50, 980, 1250, 48, Color.smoke[0], Color.smoke[1]);
    drawText(context, 'swITch', 100, 120, 48, 700);
    drawText(context, labels.title, 980, 120, 34, 700, 'right');

    const winners = matchResultWinners(result);
    const winnerIds = new Set(winners.map((winner) => winner.playerId));
    drawText(context, winners.length === 0 ? labels.noWinner : labels.winner, 540, 185, 27, 700, 'center');
    if (winners.length === 0) {
        drawText(context, labels.noWinner, 540, 290, 40, 700, 'center');
        drawText(context, labels.noWinnerDetail, 540, 350, 22, 500, 'center');
    }
    winners.forEach((winner, index) => {
        const winnerColor = Color.user[(winner.slot - 1) % Color.user.length]!;
        const x = winners.length === 1 ? 325 : 100 + index * 450;
        roundRect(context, x, 215, 430, 235, 32, winnerColor[0], winnerColor[1]);
        context.beginPath();
        context.arc(x + 100, 330, 62, 0, Math.PI * 2);
        context.fillStyle = Color.white;
        context.fill();
        context.lineWidth = 6;
        context.strokeStyle = winnerColor[1];
        context.stroke();
        drawText(context, String(winner.slot), x + 100, 334, 58, 700, 'center');
        drawText(context, '★', x + 158, 273, 38, 700, 'center');
        drawText(context, winner.nickname, x + 185, 305, 31, 700);
        drawText(context, `${labels.tags} ${winner.tagCount}`, x + 185, 352, 20, 500);
        drawText(context, `${labels.switchRate} ${winner.switchSuccess}/${winner.switchTry}`, x + 185, 389, 20, 500);
    });

    roundRect(context, 100, 485, 880, 105, 25, Color.white, Color.smoke[1]);
    drawText(context, labels.map, 145, 540, 24, 500);
    drawText(context, labels.duration, 935, 540, 24, 700, 'right');

    drawText(context, labels.player, 145, 598, 18, 700);
    drawText(context, labels.switchRate, 755, 598, 18, 700, 'right');
    drawText(context, labels.tags, 935, 598, 18, 700, 'right');

    const sortedPlayers = [...result.players].sort((a, b) => a.slot - b.slot);
    const rowHeight = 78;
    sortedPlayers.slice(0, 8).forEach((player, index) => {
        const y = 615 + index * rowHeight;
        const playerColor = Color.user[(player.slot - 1) % Color.user.length]!;
        const isWinner = winnerIds.has(player.playerId);
        const rowFill = player.isSelf ? Color.blue[0] : isWinner ? Color.frenzy[0] : Color.white;
        const rowStroke = player.isSelf ? Color.blue[2] : isWinner ? Color.frenzy[1] : Color.smoke[1];
        roundRect(context, 100, y, 880, 66, 18, rowFill, rowStroke);
        context.beginPath();
        context.arc(145, y + 33, 23, 0, Math.PI * 2);
        context.fillStyle = playerColor[0];
        context.fill();
        context.lineWidth = 3;
        context.strokeStyle = playerColor[1];
        context.stroke();
        drawText(context, String(player.slot), 145, y + 35, 17, 700, 'center');
        drawText(context, `${player.nickname}${player.isSelf ? ` · ${labels.you}` : ''}`, 190, y + 34, 23, player.isSelf ? 700 : 500);
        if (isWinner) drawText(context, labels.victory, 610, y + 34, 18, 700, 'right');
        const successRate = Math.round(player.switchSuccess / Math.max(1, player.switchTry) * 100);
        drawText(context, `${labels.switchRate} ${successRate}%`, 755, y + 34, 20, 700, 'right');
        drawText(context, `${labels.tags} ${player.tagCount}`, 935, y + 34, 20, 700, 'right');
    });

    drawText(context, `MATCH ${result.matchId}`, 100, 1260, 19, 500);
    drawText(context, 'switch-game', 980, 1260, 19, 500, 'right');

    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('IMAGE_EXPORT_FAILED')), 'image/png');
    });
}

export type ResultImageAction = 'shared' | 'saved';

export async function shareOrSaveResultImage(blob: Blob, matchId: string, shareText: string): Promise<ResultImageAction> {
    const file = new File([blob], `switch-result-${matchId}.png`, { type: 'image/png' });
    const shareData: ShareData = { files: [file], title: 'swITch', text: shareText };

    if (navigator.share && navigator.canShare?.(shareData)) {
        await navigator.share(shareData);
        return 'shared';
    }

    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = file.name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    return 'saved';
}
