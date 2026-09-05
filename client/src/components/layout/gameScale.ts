export const GAME_DESIGN_WIDTH = 1920;
export const GAME_DESIGN_HEIGHT = 1080;

/** Fixed-stage scale shared by layout code and HUD accessibility tests. */
export const gameCanvasScale = (viewportWidth: number, viewportHeight: number, fillFactor = 1): number =>
    Math.min(viewportWidth / GAME_DESIGN_WIDTH, viewportHeight / GAME_DESIGN_HEIGHT) * fillFactor;
