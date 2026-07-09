export interface TerminalContainerSize {
	width: number;
	height: number;
}

/**
 * A terminal can only be laid out inside a container that has real, positive
 * pixel dimensions. Fitting an invisible or degenerate (zero-size) container
 * makes xterm reflow to a nonsense geometry, which in turn changes the observed
 * box and re-fires the ResizeObserver — the feedback loop that pins the renderer
 * at ~100% CPU for stale sessions.
 */
export function hasRenderableTerminalSize(size: TerminalContainerSize): boolean {
	return size.width > 0 && size.height > 0;
}

/**
 * Decide whether a debounced resize should actually run `fitAddon.fit()`.
 *
 * Fitting is skipped when the container is not renderable, and when its size is
 * unchanged since the last fit — a no-op fit only reflows the viewport and can
 * re-trigger the observer without ever converging.
 */
export function shouldFitTerminalContainer(
	next: TerminalContainerSize,
	previous: TerminalContainerSize | null,
): boolean {
	if (!hasRenderableTerminalSize(next)) {
		return false;
	}
	if (previous && next.width === previous.width && next.height === previous.height) {
		return false;
	}
	return true;
}
