/** Geometry for the Minesweeper board inside a worker-window viewport. */
export type MinesweeperLayout = {
  cell: number;
  boardX: number;
  boardY: number;
  boardWidth: number;
  boardHeight: number;
  panelX: number;
  firstHintY: number;
  secondHintY: number;
};

const COLS = 12;
const ROWS = 9;
const MAX_CELL = 26;
const MIN_CELL = 20;
const BOARD_X = 14;
const SMALL_LINE_HEIGHT = 16;

/** Scale the grid just enough to fit compact 232px content without clipping. */
export function minesweeperLayout(viewportHeight: number): MinesweeperLayout {
  const height = Math.max(1, Math.floor(viewportHeight));
  const cell = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor((height - 16) / ROWS)));
  const boardHeight = ROWS * cell;
  const boardY = Math.max(2, Math.min(14, Math.floor((height - boardHeight) / 2)));
  const boardWidth = COLS * cell;
  return {
    cell,
    boardX: BOARD_X,
    boardY,
    boardWidth,
    boardHeight,
    panelX: BOARD_X + boardWidth + 20,
    firstHintY: Math.max(0, height - SMALL_LINE_HEIGHT * 2 - 4),
    secondHintY: Math.max(0, height - SMALL_LINE_HEIGHT),
  };
}
