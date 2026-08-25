/** Geometry for the falling-blocks board inside a worker-window viewport. */
export type BlocksLayout = {
  cell: number;
  boardX: number;
  boardY: number;
  boardWidth: number;
  boardHeight: number;
  panelX: number;
  firstHintY: number;
  secondHintY: number;
};

const COLS = 10;
const ROWS = 20;
const MAX_CELL = 12;
const MIN_CELL = 8;
const BOARD_X = 60;
const PANEL_X = 230;
const SMALL_LINE_HEIGHT = 16;

/**
 * Preserve the original 12px board whenever it fits, but shrink it to 10px
 * in the shell's 232px compact viewport. Ring input is logical rather than
 * coordinate based, so this visual scale does not alter the controls.
 */
export function blocksLayout(viewportHeight: number): BlocksLayout {
  const height = Math.max(1, Math.floor(viewportHeight));
  const cell = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor((height - 20) / ROWS)));
  const boardHeight = ROWS * cell;
  const boardY = Math.max(2, Math.min(10, Math.floor((height - boardHeight) / 2)));
  return {
    cell,
    boardX: BOARD_X,
    boardY,
    boardWidth: COLS * cell,
    boardHeight,
    panelX: PANEL_X,
    firstHintY: Math.max(0, height - SMALL_LINE_HEIGHT * 2 - 4),
    secondHintY: Math.max(0, height - SMALL_LINE_HEIGHT),
  };
}
