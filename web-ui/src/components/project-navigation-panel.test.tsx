import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectNavigationPanel } from "@/components/project-navigation-panel";
import { useProjectNavigationLayout } from "@/resize/use-project-navigation-layout";
import type { RuntimeClineProviderSettings, RuntimeProjectSummary } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";

vi.mock("@/resize/layout-customizations", () => ({
	useLayoutResetEffect: () => {},
}));

vi.mock("@radix-ui/react-dropdown-menu", () => {
	return {
		Root: ({ children }: any) => {
			return <div className="mock-dropdown-root">{children}</div>;
		},
		Trigger: ({ children }: any) => {
			return children;
		},
		Portal: ({ children }: any) => {
			return <>{children}</>;
		},
		Content: ({ children, className }: any) => {
			return (
				<div className={className} role="menu">
					{children}
				</div>
			);
		},
		Item: ({ children, className, onSelect }: any) => {
			return (
				<button
					type="button"
					className={className}
					role="menuitem"
					onClick={() => {
						onSelect?.();
					}}
				>
					{children}
				</button>
			);
		},
	};
});

/** Wrapper that owns the sidebar layout state via the hook and passes it as props. */
function PanelWithLayout(
	props: Omit<
		ComponentProps<typeof ProjectNavigationPanel>,
		"sidebarWidth" | "setExpandedSidebarWidth" | "isCollapsed" | "setSidebarCollapsed"
	>,
): React.ReactElement {
	const layout = useProjectNavigationLayout();
	return <ProjectNavigationPanel {...props} {...layout} />;
}

const SIDEBAR_MIN_EXPANDED_WIDTH = 200;
const SIDEBAR_MAX_EXPANDED_WIDTH = 600;
const BOARD_SURFACE_HORIZONTAL_CHROME_PX = 40;

const PROJECTS: RuntimeProjectSummary[] = [
	{
		id: "project-1",
		name: "Kanban",
		path: "/tmp/kanban",
		taskCounts: {
			backlog: 0,
			in_progress: 0,
			review: 0,
			done: 0,
			trash: 0,
		},
	},
];

const CLINE_OAUTH_SETTINGS: RuntimeClineProviderSettings = {
	providerId: null,
	modelId: "cline-sonnet",
	baseUrl: null,
	reasoningEffort: null,
	apiKeyConfigured: false,
	oauthProvider: "cline",
	oauthAccessTokenConfigured: true,
	oauthRefreshTokenConfigured: true,
	oauthAccountId: "acc-1",
	oauthExpiresAt: 1_800_000_000_000,
};

function getSidebar(container: HTMLElement): HTMLElement {
	const sidebar = container.querySelector("aside");
	if (!sidebar) {
		throw new Error("Sidebar was not rendered");
	}
	return sidebar;
}

function getResizeHandle(container: HTMLElement): HTMLElement {
	const handle = container.querySelector('[aria-label="Resize sidebar"]');
	if (!handle) {
		throw new Error("Resize handle was not rendered");
	}
	return handle as HTMLElement;
}

function getButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === text);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`Button with text "${text}" was not rendered`);
	}
	return button;
}

describe("ProjectNavigationPanel width persistence", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let previousAppVersion: unknown;
	let previousInnerWidth: number;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		previousAppVersion = (globalThis as typeof globalThis & { __APP_VERSION__?: unknown }).__APP_VERSION__;
		(globalThis as typeof globalThis & { __APP_VERSION__?: string }).__APP_VERSION__ = "test";
		(globalThis as typeof globalThis & { __APP_COMMIT__?: string }).__APP_COMMIT__ = "abc1234";
		previousInnerWidth = window.innerWidth;
		Object.defineProperty(window, "innerWidth", {
			value: 1600,
			configurable: true,
			writable: true,
		});
		localStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		localStorage.clear();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		if (typeof previousAppVersion === "undefined") {
			delete (globalThis as typeof globalThis & { __APP_VERSION__?: unknown }).__APP_VERSION__;
		} else {
			(globalThis as typeof globalThis & { __APP_VERSION__?: unknown }).__APP_VERSION__ = previousAppVersion;
		}
		Object.defineProperty(window, "innerWidth", {
			value: previousInnerWidth,
			configurable: true,
			writable: true,
		});
	});

	function renderPanel(overrides: Partial<ComponentProps<typeof PanelWithLayout>> = {}): void {
		act(() => {
			root.render(
				<PanelWithLayout
					projects={PROJECTS}
					currentProjectId="project-1"
					removingProjectId={null}
					activeSection="projects"
					onActiveSectionChange={() => {}}
					canShowAgentSection
					selectedAgentId={null}
					clineProviderSettings={null}
					featurebaseFeedbackState={undefined}
					onSelectProject={() => {}}
					onRemoveProject={async () => true}
					onAddProject={() => {}}
					{...overrides}
				/>,
			);
		});
	}

	function getExpectedDefaultWidthPx(viewportWidth: number): number {
		const proportionalWidth = Math.round((viewportWidth - BOARD_SURFACE_HORIZONTAL_CHROME_PX) / 5);
		return Math.max(SIDEBAR_MIN_EXPANDED_WIDTH, Math.min(SIDEBAR_MAX_EXPANDED_WIDTH, proportionalWidth));
	}

	function clampExpandedWidth(width: number): number {
		return Math.max(SIDEBAR_MIN_EXPANDED_WIDTH, Math.min(SIDEBAR_MAX_EXPANDED_WIDTH, width));
	}

	it("uses a proportional one-fifth default width when no value is persisted", () => {
		renderPanel();
		const sidebar = getSidebar(container);
		expect(sidebar.style.width).toBe(`${getExpectedDefaultWidthPx(window.innerWidth)}px`);
	});

	it("persists resized width and restores it on remount", () => {
		renderPanel();
		const initialWidth = getExpectedDefaultWidthPx(window.innerWidth);
		const expectedResizedWidth = clampExpandedWidth(initialWidth + 160);
		const resizeHandle = getResizeHandle(container);
		act(() => {
			resizeHandle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 300 }));
		});
		act(() => {
			window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 460 }));
		});
		act(() => {
			window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		});

		expect(localStorage.getItem(LocalStorageKey.ProjectNavigationPanelWidth)).toBe(String(expectedResizedWidth));

		act(() => {
			root.unmount();
		});
		root = createRoot(container);

		renderPanel();
		const sidebar = getSidebar(container);
		expect(sidebar.style.width).toBe(`${expectedResizedWidth}px`);
	});

	it("renders beta hint card with report issue in the projects view", () => {
		renderPanel();
		expect(container.textContent).toContain("Kanban is in beta. Help us improve by sharing your experience.");
		expect(container.textContent).toContain("Report issue");
	});

	it("shows send feedback instead of report issue when Cline OAuth is available", () => {
		renderPanel({
			selectedAgentId: "cline",
			clineProviderSettings: CLINE_OAUTH_SETTINGS,
			featurebaseFeedbackState: {
				authState: "ready",
				widgetOpenCount: 0,
				openFeedbackWidget: vi.fn(async () => {}),
			},
		});
		expect(container.textContent).toContain("Kanban is in beta. Help us improve by sharing your experience.");
		expect(container.textContent).toContain("Send feedback");
		expect(container.textContent).not.toContain("Report issue");
	});

	it("persists terminal tips dismissal", () => {
		renderPanel({
			activeSection: "agent",
			selectedAgentId: "droid",
		});
		expect(container.textContent).toContain("Tips");
		expect(localStorage.getItem(LocalStorageKey.AgentTipsDismissed)).toBeNull();

		const hideButton = container.querySelector('[aria-label="Dismiss tips"]') as HTMLButtonElement;
		act(() => {
			hideButton.click();
		});

		expect(container.textContent).toContain("Show tips");
		expect(localStorage.getItem(LocalStorageKey.AgentTipsDismissed)).toBe("true");

		const showTipsButton = getButtonByText(container, "Show tips");
		act(() => {
			showTipsButton.click();
		});

		expect(container.textContent).toContain("Tips");
		expect(localStorage.getItem(LocalStorageKey.AgentTipsDismissed)).toBeNull();
	});

	it("renders fleet production line branding with commit SHA", () => {
		renderPanel();
		expect(container.textContent).toContain("fleet production line");
		expect(container.textContent).toContain("abc1234");
	});

	it("renders active epics with their roll-up and hides them from the plain Projects list", () => {
		const projectsWithEpic: RuntimeProjectSummary[] = [
			{
				id: "project-1",
				name: "My App",
				path: "/tmp/myapp",
				taskCounts: {
					backlog: 5,
					in_progress: 3,
					review: 2,
					done: 0,
					trash: 1,
				},
			},
			{
				id: "epic-1",
				name: "Epic Card Refactor",
				path: "/tmp/epic-1",
				taskCounts: {
					backlog: 3,
					in_progress: 2,
					review: 1,
					done: 0,
					trash: 0,
				},
				epic: {
					name: "Card Refactor Epic",
					branch: "epic/card-refactor",
				},
			},
		];

		renderPanel({ projects: projectsWithEpic });

		// It should render "Senior Architect" header & row
		expect(container.textContent).toContain("Senior Architect");
		expect(container.textContent).toContain("Senior Architect Chat");

		// It should render "Epics" header and the epic's roll-up: counts (3·2·1) and CI checkmark (✓)
		expect(container.textContent).toContain("Epics");
		expect(container.textContent).toContain("Card Refactor Epic");
		expect(container.textContent).toContain("3·2·1");
		expect(container.textContent).toContain("✓");

		// It should render "Projects" header and the plain project
		expect(container.textContent).toContain("Projects");
		expect(container.textContent).toContain("My App");
	});

	it("renders no Epics section if there are no epics", () => {
		renderPanel({ projects: PROJECTS });
		expect(container.textContent).not.toContain("Epics");
		expect(container.textContent).toContain("Projects");
		expect(container.textContent).toContain("Kanban");
	});

	it("renders archived epics with archived flag and keeps them listed", () => {
		const projectsWithArchivedEpic: RuntimeProjectSummary[] = [
			{
				id: "project-1",
				name: "My App",
				path: "/tmp/myapp",
				taskCounts: {
					backlog: 5,
					in_progress: 3,
					review: 2,
					done: 0,
					trash: 1,
				},
			},
			{
				id: "epic-archived",
				name: "Epic Arch Refactor",
				path: "/tmp/epic-archived",
				taskCounts: {
					backlog: 3,
					in_progress: 2,
					review: 1,
					done: 0,
					trash: 0,
				},
				epic: {
					name: "Archived Epic",
					branch: "epic/archived",
					archived: true,
				},
			},
		];

		renderPanel({ projects: projectsWithArchivedEpic });

		expect(container.textContent).toContain("Epics");
		expect(container.textContent).toContain("Archived Epic");
		expect(container.textContent).toContain("3·2·1");
	});

	it("renders the thin context switcher under the Agent section, reflecting the active context in the trigger and handling selection clicks", () => {
		const projectsWithEpic: RuntimeProjectSummary[] = [
			{
				id: "project-1",
				name: "My App",
				path: "/tmp/myapp",
				taskCounts: {
					backlog: 5,
					in_progress: 3,
					review: 2,
					done: 0,
					trash: 1,
				},
			},
			{
				id: "epic-1",
				name: "Epic Card Refactor",
				path: "/tmp/epic-1",
				taskCounts: {
					backlog: 3,
					in_progress: 2,
					review: 1,
					done: 0,
					trash: 0,
				},
				epic: {
					name: "Card Refactor Epic",
					branch: "epic/card-refactor",
				},
			},
		];

		const onSelectProject = vi.fn();

		// Case 1: Active section is 'agent', currentProjectId is 'project-1' (Architect Agent active)
		renderPanel({
			projects: projectsWithEpic,
			currentProjectId: "project-1",
			activeSection: "agent",
			architectWorkspaceId: "project-1",
			onSelectProject,
		});

		// The tab toggle itself should just say "Agent", not "Architect Agent" or "Epic Agent"
		const tabButtons = Array.from(container.querySelectorAll("button"));
		const agentTabButton = tabButtons.find((btn) => btn.textContent === "Agent");
		expect(agentTabButton).toBeDefined();

		// The trigger button should show "Architect Agent"
		const triggerButton = container.querySelector("button[aria-label='Agent context switcher']");
		expect(triggerButton).toBeDefined();
		expect(triggerButton?.textContent).toContain("Architect Agent");

		// Click the trigger to open the dropdown menu
		act(() => {
			triggerButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		// Find the dropdown menu items in the document (Radix Portal mounts them to document.body)
		const menuItems = Array.from(container.querySelectorAll("[role='menuitem']"));
		expect(menuItems.length).toBe(2);

		const architectItem = menuItems.find((item) => item.textContent?.includes("Architect Agent"));
		const epicItem = menuItems.find((item) => item.textContent?.includes("Card Refactor Epic Agent"));

		expect(architectItem).toBeDefined();
		expect(epicItem).toBeDefined();

		// Selecting the epic item should trigger onSelectProject with the epic ID
		act(() => {
			epicItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(onSelectProject).toHaveBeenCalledWith("epic-1");

		// Case 2: active context is epic-1
		onSelectProject.mockClear();
		renderPanel({
			projects: projectsWithEpic,
			currentProjectId: "epic-1",
			activeSection: "agent",
			architectWorkspaceId: "project-1",
			onSelectProject,
		});

		const updatedTrigger = container.querySelector("button[aria-label='Agent context switcher']");
		expect(updatedTrigger?.textContent).toContain("Card Refactor Epic Agent");

		// Open the menu again
		act(() => {
			updatedTrigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		const updatedMenuItems = Array.from(document.querySelectorAll("[role='menuitem']"));
		const updatedArchitectItem = updatedMenuItems.find((item) => item.textContent?.includes("Architect Agent"));

		// Selecting the Architect item should trigger onSelectProject with the architect ID
		act(() => {
			updatedArchitectItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(onSelectProject).toHaveBeenCalledWith("project-1");
	});

	it("renders the Agent session menu only for a resolvable Agent workspace and starts fresh for that workspace", () => {
		const onStartFreshAgentSession = vi.fn();

		renderPanel({
			activeSection: "agent",
			architectWorkspaceId: "project-1",
			onStartFreshAgentSession,
		});

		const triggerButton = container.querySelector("button[aria-label='Agent session menu']");
		expect(triggerButton).toBeInstanceOf(HTMLButtonElement);

		act(() => {
			triggerButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		const menuItem = Array.from(document.querySelectorAll("[role='menuitem']")).find((item) =>
			item.textContent?.includes("Start fresh Session"),
		);
		expect(menuItem).toBeDefined();

		act(() => {
			menuItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(onStartFreshAgentSession).toHaveBeenCalledWith("project-1");

		renderPanel({
			activeSection: "agent",
			currentProjectId: null,
			canShowAgentSection: false,
			onStartFreshAgentSession,
		});

		expect(container.querySelector("button[aria-label='Agent session menu']")).toBeNull();
	});
});
