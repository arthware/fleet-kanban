import * as Collapsible from "@radix-ui/react-collapsible";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
	Archive,
	ChevronDown,
	ChevronUp,
	Command,
	Ellipsis,
	ExternalLink,
	Info,
	Lightbulb,
	Plus,
	X,
} from "lucide-react";
import { type MouseEvent as ReactMouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AgentBudgetReadout } from "@/components/agent-budget-readout";
import { canShowFeaturebaseFeedbackButton } from "@/components/featurebase-feedback-button";
import { FleetUpdateReadout } from "@/components/fleet-update-readout";
import { Button } from "@/components/ui/button";
import { ClineIcon } from "@/components/ui/cline-icon";
import { cn } from "@/components/ui/cn";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import type { FeaturebaseFeedbackState } from "@/hooks/use-featurebase-feedback-widget";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { resolveAgentChatWorkspace } from "@/runtime/agent-chat-workspace";
import type {
	RuntimeAgentBudgetResponse,
	RuntimeAgentId,
	RuntimeClineProviderSettings,
	RuntimeProjectSummary,
} from "@/runtime/types";
import {
	LocalStorageKey,
	readLocalStorageItem,
	removeLocalStorageItem,
	writeLocalStorageItem,
} from "@/storage/local-storage-store";
import { formatPathForDisplay } from "@/utils/path-display";
import { isMacPlatform, modifierKeyLabel } from "@/utils/platform";
import { useUnmount, useWindowEvent } from "@/utils/react-use";

const COLLAPSED_WIDTH = 48;
const SIDEBAR_COLLAPSE_THRESHOLD = 120;
const SIDEBAR_MIN_EXPANDED_WIDTH = 200;
const SIDEBAR_MAX_EXPANDED_WIDTH = 600;
const GITHUB_ISSUES_URL = "https://github.com/cline/kanban/issues";

interface TaskCountBadge {
	id: string;
	title: string;
	shortLabel: string;
	toneClassName: string;
	count: number;
}

function EpicBadge({ name }: { name: string }) {
	const letter = name.charAt(0).toUpperCase();
	return (
		<span className="w-4 h-4 rounded text-[9px] font-bold shrink-0 border border-accent/20 bg-accent/15 text-accent flex items-center justify-center select-none">
			{letter}
		</span>
	);
}

export function ProjectNavigationPanel({
	projects,
	isLoadingProjects = false,
	currentProjectId,
	removingProjectId,
	activeSection,
	onActiveSectionChange,
	canShowAgentSection,
	agentSectionContent,
	selectedAgentId,
	clineProviderSettings,
	featurebaseFeedbackState,
	agentBudget,
	onSelectProject,
	onRemoveProject,
	onAddProject,
	sidebarWidth,
	setExpandedSidebarWidth,
	isCollapsed,
	setSidebarCollapsed,
	architectWorkspaceId = null,
}: {
	projects: RuntimeProjectSummary[];
	isLoadingProjects?: boolean;
	currentProjectId: string | null;
	removingProjectId: string | null;
	activeSection: "projects" | "agent";
	onActiveSectionChange: (section: "projects" | "agent") => void;
	canShowAgentSection: boolean;
	agentSectionContent?: ReactNode;
	selectedAgentId?: RuntimeAgentId | null;
	clineProviderSettings?: RuntimeClineProviderSettings | null;
	featurebaseFeedbackState?: FeaturebaseFeedbackState;
	agentBudget?: RuntimeAgentBudgetResponse | null;
	onSelectProject: (projectId: string) => void;
	onRemoveProject: (projectId: string) => Promise<boolean>;
	onAddProject: () => void;
	sidebarWidth: number;
	setExpandedSidebarWidth: (width: number) => void;
	isCollapsed: boolean;
	setSidebarCollapsed: (collapsed: boolean, persist?: boolean) => void;
	architectWorkspaceId?: string | null;
}): React.ReactElement {
	const sortedProjects = [...projects].sort((a, b) => a.path.localeCompare(b.path));

	const hasEpics = sortedProjects.some((p) => p.epic);
	const showSwitcher = activeSection === "agent" && architectWorkspaceId !== null && hasEpics;

	const { agentChatWorkspaceId } = resolveAgentChatWorkspace({
		architectWorkspaceId,
		currentProjectId,
		projects: sortedProjects,
	});

	const activeAgentProject = sortedProjects.find((p) => p.id === agentChatWorkspaceId);
	const epicProjects = sortedProjects.filter((p) => p.epic);

	const shouldShowFeaturebaseFeedback = canShowFeaturebaseFeedbackButton({
		selectedAgentId,
		clineProviderSettings,
		featurebaseFeedbackState,
	});

	const [pendingProjectRemoval, setPendingProjectRemoval] = useState<RuntimeProjectSummary | null>(null);
	const isProjectRemovalPending = pendingProjectRemoval !== null && removingProjectId === pendingProjectRemoval.id;
	const pendingProjectTaskCount = pendingProjectRemoval
		? pendingProjectRemoval.taskCounts.backlog +
			pendingProjectRemoval.taskCounts.in_progress +
			pendingProjectRemoval.taskCounts.review +
			pendingProjectRemoval.taskCounts.trash
		: 0;

	const isMobile = useIsMobile();
	const [isMobileClosing, setIsMobileClosing] = useState(false);

	useEffect(() => {
		if (isMobile) {
			setSidebarCollapsed(true, false);
		}
		// Only auto-collapse when crossing the mobile breakpoint, not on every isCollapsed change.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isMobile]);

	const setCollapsed = useCallback(
		(collapsed: boolean) => {
			if (isMobile && collapsed) {
				setIsMobileClosing(true);
				return;
			}
			setSidebarCollapsed(collapsed, !isMobile);
		},
		[isMobile, setSidebarCollapsed],
	);

	const handleMobileCloseAnimationEnd = useCallback(() => {
		setIsMobileClosing(false);
		setSidebarCollapsed(true, false);
	}, [setSidebarCollapsed]);

	const [isDragging, setIsDragging] = useState(false);
	const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
	const previousBodyStyleRef = useRef<{ userSelect: string; cursor: string } | null>(null);

	const stopDrag = useCallback(() => {
		setIsDragging(false);
		const previousStyle = previousBodyStyleRef.current;
		if (previousStyle) {
			document.body.style.userSelect = previousStyle.userSelect;
			document.body.style.cursor = previousStyle.cursor;
			previousBodyStyleRef.current = null;
		}
		dragRef.current = null;
	}, []);

	useUnmount(stopDrag);

	const handleMouseMove = useCallback(
		(event: MouseEvent) => {
			if (!isDragging) {
				return;
			}
			const dragState = dragRef.current;
			if (!dragState) {
				return;
			}
			const delta = event.clientX - dragState.startX;
			const newWidth = dragState.startWidth + delta;
			if (newWidth < SIDEBAR_COLLAPSE_THRESHOLD) {
				if (!isCollapsed) {
					setCollapsed(true);
				}
				return;
			}
			if (isCollapsed) {
				setCollapsed(false);
			}
			setExpandedSidebarWidth(newWidth);
		},
		[isCollapsed, isDragging, setExpandedSidebarWidth, setCollapsed],
	);

	const handleMouseUp = useCallback(() => {
		if (!isDragging) {
			return;
		}
		stopDrag();
	}, [isDragging, stopDrag]);

	useWindowEvent("mousemove", isDragging ? handleMouseMove : null);
	useWindowEvent("mouseup", isDragging ? handleMouseUp : null);

	const startDrag = useCallback(
		(e: ReactMouseEvent) => {
			e.preventDefault();
			if (isDragging) {
				stopDrag();
			}
			dragRef.current = { startX: e.clientX, startWidth: isCollapsed ? COLLAPSED_WIDTH : sidebarWidth };
			setIsDragging(true);
			previousBodyStyleRef.current = {
				userSelect: document.body.style.userSelect,
				cursor: document.body.style.cursor,
			};
			document.body.style.userSelect = "none";
			document.body.style.cursor = "ew-resize";
		},
		[isCollapsed, isDragging, sidebarWidth, stopDrag],
	);

	if (isMobile && isCollapsed && !isMobileClosing) {
		return <></>;
	}

	const collapsedWidth = COLLAPSED_WIDTH;

	if (isCollapsed) {
		return (
			<aside
				className="flex flex-col items-center min-h-0 overflow-hidden bg-surface-1 relative shrink-0 py-2 gap-1.5"
				style={{
					width: collapsedWidth,
					minWidth: collapsedWidth,
					borderRight: "1px solid var(--color-divider)",
				}}
			>
				{!isMobile && (
					<div
						role="separator"
						aria-orientation="vertical"
						aria-label="Resize sidebar"
						onMouseDown={startDrag}
						className="absolute top-0 right-0 bottom-0 w-1.5 cursor-ew-resize z-10"
					/>
				)}
				{sortedProjects
					.filter((p) => !p.epic)
					.map((project) => {
						const isCurrent = currentProjectId === project.id;
						const letter = project.name.charAt(0).toUpperCase();
						return (
							<button
								key={project.id}
								type="button"
								title={project.name}
								onClick={() => {
									if (isMobile) {
										setCollapsed(false);
									}
									onSelectProject(project.id);
								}}
								className={cn(
									"rounded-md text-xs font-semibold shrink-0 border-0 cursor-pointer flex items-center justify-center",
									isMobile ? "w-11 h-11" : "w-8 h-8",
									isCurrent
										? "bg-accent text-accent-fg"
										: "bg-surface-3 text-text-secondary hover:text-text-primary hover:bg-surface-4",
								)}
							>
								{letter}
							</button>
						);
					})}
				{sortedProjects.filter((p) => p.epic).length > 0 ? (
					<>
						<div className="w-4 h-px bg-border my-1 shrink-0" />
						{sortedProjects
							.filter((p) => p.epic)
							.map((project) => {
								const isCurrent = currentProjectId === project.id;
								const letter = (project.epic?.name ?? project.name).charAt(0).toUpperCase();
								const isArchived = !!project.epic?.archived;
								return (
									<button
										key={project.id}
										type="button"
										title={project.epic?.name ?? project.name}
										onClick={() => {
											if (isMobile) {
												setCollapsed(false);
											}
											onSelectProject(project.id);
										}}
										className={cn(
											"rounded-md text-xs font-semibold shrink-0 border-0 cursor-pointer flex items-center justify-center relative",
											isMobile ? "w-11 h-11" : "w-8 h-8",
											isCurrent
												? "bg-accent text-accent-fg"
												: isArchived
													? "bg-surface-3 text-text-tertiary hover:bg-surface-4 hover:text-text-secondary border border-border/50 opacity-60"
													: "bg-accent/15 text-accent hover:text-accent hover:bg-accent/25 border border-accent/20",
										)}
									>
										{isArchived ? <Archive size={14} className="shrink-0" /> : letter}
									</button>
								);
							})}
					</>
				) : null}
				<button
					type="button"
					title="Add project"
					onClick={onAddProject}
					disabled={removingProjectId !== null}
					className={cn(
						"rounded-md text-xs shrink-0 border-0 cursor-pointer flex items-center justify-center bg-transparent text-text-tertiary hover:text-text-secondary hover:bg-surface-2 mt-auto",
						isMobile ? "w-11 h-11" : "w-8 h-8",
					)}
				>
					<Plus size={16} />
				</button>
			</aside>
		);
	}

	return (
		<aside
			className={cn(
				"flex flex-col min-h-0 overflow-hidden bg-surface-1 shrink-0",
				isMobile ? "fixed inset-y-0 left-0 z-50 shadow-2xl" : "relative",
			)}
			onAnimationEnd={isMobileClosing ? handleMobileCloseAnimationEnd : undefined}
			style={
				isMobile
					? {
							width: "100vw",
							animation: isMobileClosing
								? "kb-sidebar-slide-out 200ms ease forwards"
								: "kb-sidebar-slide-in 200ms ease",
						}
					: {
							width: sidebarWidth,
							minWidth: SIDEBAR_MIN_EXPANDED_WIDTH,
							maxWidth: SIDEBAR_MAX_EXPANDED_WIDTH,
							borderRight: "1px solid var(--color-divider)",
						}
			}
		>
			{!isMobile && (
				<div
					role="separator"
					aria-orientation="vertical"
					aria-label="Resize sidebar"
					onMouseDown={startDrag}
					className="absolute top-0 right-0 bottom-0 w-1.5 cursor-ew-resize z-10"
				/>
			)}
			<div style={{ padding: "12px 12px 8px" }}>
				<div className="flex items-center justify-between">
					<div className="font-semibold text-base flex items-baseline gap-1.5">
						<ClineIcon size={18} className="text-text-primary shrink-0 self-center" />
						fleet production line{" "}
						<span className="text-text-secondary font-normal text-xs">{__APP_COMMIT__}</span>
					</div>
					{isMobile ? (
						<Button
							variant="ghost"
							size="sm"
							icon={<Plus size={16} className="rotate-45" />}
							onClick={() => setCollapsed(true)}
							aria-label="Close sidebar"
							className="min-w-[44px] min-h-[44px] -mr-2"
						/>
					) : (
						<div className="flex items-center gap-1.5 shrink-0">
							{/* Fixed-size slot: keeps the budget readout's position stable whether or
							    not an update icon is currently rendered inside it. */}
							<div className="flex h-7 w-7 shrink-0 items-center justify-center">
								<FleetUpdateReadout />
							</div>
							<AgentBudgetReadout budget={agentBudget ?? null} />
						</div>
					)}
				</div>
				<div className="mt-2 rounded-md bg-surface-2 border border-border p-1">
					<div className="grid grid-cols-2 gap-1">
						<button
							type="button"
							onClick={() => onActiveSectionChange("projects")}
							className={cn(
								"cursor-pointer rounded-sm px-2 py-1 text-xs font-medium",
								activeSection === "projects"
									? "bg-surface-4 text-text-primary border border-border"
									: "text-text-secondary hover:text-text-primary border border-transparent",
							)}
						>
							Projects
						</button>
						<button
							type="button"
							onClick={() => onActiveSectionChange("agent")}
							disabled={!canShowAgentSection}
							className={cn(
								"cursor-pointer rounded-sm px-2 py-1 text-xs font-medium",
								activeSection === "agent"
									? "bg-surface-4 text-text-primary border border-border"
									: "text-text-secondary hover:text-text-primary border border-transparent",
								!canShowAgentSection ? "cursor-not-allowed opacity-50" : null,
							)}
						>
							Agent
						</button>
					</div>
				</div>
				{showSwitcher && (
					<div className="mt-2">
						<DropdownMenu.Root>
							<DropdownMenu.Trigger asChild>
								<button
									type="button"
									aria-label="Agent context switcher"
									className="w-full cursor-pointer rounded-md border border-border bg-surface-2 hover:bg-surface-3 transition-colors flex items-center justify-between gap-2 px-2.5 py-1.5 focus:outline-none"
								>
									<div className="flex items-center gap-2 min-w-0 text-left">
										{activeAgentProject?.epic ? (
											<>
												<EpicBadge name={activeAgentProject.epic.name ?? activeAgentProject.name} />
												<span className="text-xs font-medium text-text-primary truncate">
													{activeAgentProject.epic.name ?? activeAgentProject.name} Agent
												</span>
											</>
										) : (
											<>
												<Command size={14} className="text-text-secondary shrink-0" />
												<span className="text-xs font-medium text-text-primary truncate">
													Architect Agent
												</span>
											</>
										)}
									</div>
									<ChevronDown size={14} className="text-text-tertiary shrink-0" />
								</button>
							</DropdownMenu.Trigger>
							<DropdownMenu.Portal>
								<DropdownMenu.Content
									side="bottom"
									align="start"
									sideOffset={4}
									className="z-50 w-[var(--radix-dropdown-menu-trigger-width)] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
									onCloseAutoFocus={(event) => event.preventDefault()}
								>
									<DropdownMenu.Item
										className={cn(
											"flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-text-primary cursor-pointer outline-none data-[highlighted]:bg-surface-3",
											!activeAgentProject?.epic ? "bg-surface-2 font-medium" : "",
										)}
										onSelect={() => {
											if (architectWorkspaceId) {
												onSelectProject(architectWorkspaceId);
											}
										}}
									>
										<Command size={14} className="text-text-secondary shrink-0" />
										<span className="truncate">Architect Agent</span>
									</DropdownMenu.Item>

									{epicProjects.length > 0 && <div className="h-px bg-border my-1" />}

									{epicProjects.map((project) => {
										const isCurrent = agentChatWorkspaceId === project.id;
										const name = project.epic?.name ?? project.name;
										const isArchived = !!project.epic?.archived;
										return (
											<DropdownMenu.Item
												key={project.id}
												className={cn(
													"flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-text-primary cursor-pointer outline-none data-[highlighted]:bg-surface-3",
													isCurrent ? "bg-surface-2 font-medium" : "",
													isArchived ? "opacity-60" : "",
												)}
												onSelect={() => onSelectProject(project.id)}
											>
												<EpicBadge name={name} />
												<span className="truncate flex items-center gap-1.5">
													{isArchived && <Archive size={12} className="shrink-0" />}
													{name} Agent
												</span>
											</DropdownMenu.Item>
										);
									})}
								</DropdownMenu.Content>
							</DropdownMenu.Portal>
						</DropdownMenu.Root>
					</div>
				)}
			</div>

			{activeSection === "projects" ? (
				<>
					<div
						className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-1"
						style={{ padding: "4px 12px" }}
					>
						{sortedProjects.length === 0 && isLoadingProjects ? (
							<div style={{ padding: "4px 0" }}>
								{Array.from({ length: 3 }).map((_, index) => (
									<ProjectRowSkeleton key={`project-skeleton-${index}`} />
								))}
							</div>
						) : null}

						{(() => {
							const plainProjects = sortedProjects.filter((p) => !p.epic);
							const epicProjects = sortedProjects.filter((p) => p.epic);
							const isSeniorArchitectActive = plainProjects.some((p) => p.id === currentProjectId);

							return (
								<>
									{/* Senior Architect */}
									<div className="flex flex-col gap-1 mb-2">
										<div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider px-2 py-1 select-none">
											Senior Architect
										</div>
										<div
											role="button"
											tabIndex={0}
											onClick={() => {
												const mainlineProject = plainProjects[0];
												if (mainlineProject) {
													onSelectProject(mainlineProject.id);
													if (isMobile) {
														setCollapsed(true);
													}
												}
											}}
											onKeyDown={(e) => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault();
													const mainlineProject = plainProjects[0];
													if (mainlineProject) {
														onSelectProject(mainlineProject.id);
														if (isMobile) {
															setCollapsed(true);
														}
													}
												}
											}}
											className={cn(
												"kb-project-row cursor-pointer rounded-md flex items-center gap-2",
												isSeniorArchitectActive && "kb-project-row-selected",
											)}
											style={{ padding: "6px 8px" }}
										>
											<Command
												size={14}
												className={cn(
													"shrink-0",
													isSeniorArchitectActive ? "text-accent-fg" : "text-text-secondary",
												)}
											/>
											<div className="flex-1 min-w-0">
												<div
													className={cn(
														"font-medium text-sm whitespace-nowrap overflow-hidden text-ellipsis",
														isSeniorArchitectActive ? "text-accent-fg" : "text-text-primary",
													)}
												>
													Senior Architect Chat
												</div>
												<div
													className={cn(
														"text-[10px] whitespace-nowrap overflow-hidden text-ellipsis font-mono",
														isSeniorArchitectActive ? "text-accent-fg/60" : "text-text-secondary",
													)}
												>
													production-line
												</div>
											</div>
										</div>
									</div>

									{/* Epics Group */}
									{epicProjects.length > 0 ? (
										<div className="flex flex-col gap-1 mb-2">
											<div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider px-2 py-1 select-none">
												Epics
											</div>
											{epicProjects.map((epicProject) => {
												const isCurrent = currentProjectId === epicProject.id;
												const counts = `${epicProject.taskCounts.backlog}·${epicProject.taskCounts.in_progress}·${epicProject.taskCounts.review}`;
												const isArchived = !!epicProject.epic?.archived;

												return (
													<div
														key={epicProject.id}
														role="button"
														tabIndex={0}
														onClick={() => {
															onSelectProject(epicProject.id);
															if (isMobile) {
																setCollapsed(true);
															}
														}}
														onKeyDown={(e) => {
															if (e.key === "Enter" || e.key === " ") {
																e.preventDefault();
																onSelectProject(epicProject.id);
																if (isMobile) {
																	setCollapsed(true);
																}
															}
														}}
														className={cn(
															"kb-project-row cursor-pointer rounded-md flex items-center justify-between",
															isCurrent && "kb-project-row-selected",
															isArchived && !isCurrent && "opacity-50 hover:opacity-85",
														)}
														style={{ padding: "6px 8px" }}
													>
														<div className="flex-1 min-w-0 flex items-center gap-1.5 justify-between w-full">
															<span
																className={cn(
																	"font-medium text-sm truncate flex items-center gap-1.5",
																	isCurrent
																		? "text-accent-fg"
																		: isArchived
																			? "text-text-tertiary"
																			: "text-text-primary",
																)}
															>
																{isArchived && (
																	<Archive size={14} className="shrink-0 text-text-tertiary" />
																)}
																{epicProject.epic?.name ?? epicProject.name}
															</span>
															<span
																className={cn(
																	"font-mono text-xs shrink-0 flex items-center gap-1.5",
																	isCurrent ? "text-accent-fg/80" : "text-text-secondary",
																)}
															>
																<span className="opacity-75">{counts}</span>
																<span className="text-status-green font-bold">✓</span>
															</span>
														</div>
													</div>
												);
											})}
										</div>
									) : null}

									{/* Plain Projects Group */}
									{plainProjects.length > 0 ? (
										<div className="flex flex-col gap-1">
											<div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider px-2 py-1 select-none">
												Projects
											</div>
											{plainProjects.map((project) => (
												<ProjectRow
													key={project.id}
													project={project}
													isCurrent={currentProjectId === project.id}
													removingProjectId={removingProjectId}
													onSelect={(projectId) => {
														onSelectProject(projectId);
														if (isMobile) {
															setCollapsed(true);
														}
													}}
													onRemove={(projectId) => {
														const found = plainProjects.find((item) => item.id === projectId);
														if (!found) {
															return;
														}
														setPendingProjectRemoval(found);
													}}
												/>
											))}
										</div>
									) : null}
								</>
							);
						})()}

						{!isLoadingProjects ? (
							<button
								type="button"
								className="kb-project-row flex cursor-pointer items-center gap-1.5 rounded-md text-text-secondary hover:text-text-primary mt-2"
								style={{ padding: "6px 8px" }}
								onClick={onAddProject}
								disabled={removingProjectId !== null}
							>
								<Plus size={14} className="shrink-0" />
								<span className="text-sm">Add Project</span>
							</button>
						) : null}
					</div>
					<ShortcutsCard />
					<ProjectSupportFooter
						shouldShowFeaturebaseFeedback={shouldShowFeaturebaseFeedback}
						featurebaseFeedbackState={featurebaseFeedbackState}
					/>
				</>
			) : (
				<div className="flex flex-1 min-h-0 flex-col">
					{selectedAgentId && selectedAgentId !== "cline" ? <TerminalAgentHints /> : null}
					<div className="flex flex-1 min-h-0 overflow-hidden bg-surface-1 px-2 pb-2 pt-1">
						{agentSectionContent ?? (
							<div className="flex w-full items-center justify-center rounded-md border border-border bg-surface-2 px-3 text-center text-sm text-text-secondary">
								Select a project to use the agent.
							</div>
						)}
					</div>
				</div>
			)}
			<AlertDialog
				open={pendingProjectRemoval !== null}
				onOpenChange={(open) => {
					if (!open && !isProjectRemovalPending) {
						setPendingProjectRemoval(null);
					}
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>Remove Project</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription asChild>
						<div className="flex flex-col gap-3">
							<p>{pendingProjectRemoval ? pendingProjectRemoval.name : "This project"}</p>
							<p className="text-text-primary">
								This will delete all project tasks ({pendingProjectTaskCount}), remove task
								workspaces/worktrees, and stop any running processes for this project.
							</p>
							<p className="text-text-primary">This action cannot be undone.</p>
						</div>
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button
							variant="default"
							disabled={isProjectRemovalPending}
							onClick={() => {
								if (!isProjectRemovalPending) {
									setPendingProjectRemoval(null);
								}
							}}
						>
							Cancel
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="danger"
							disabled={isProjectRemovalPending}
							onClick={async () => {
								if (!pendingProjectRemoval) {
									return;
								}
								const removed = await onRemoveProject(pendingProjectRemoval.id);
								if (removed) {
									setPendingProjectRemoval(null);
								}
							}}
						>
							{isProjectRemovalPending ? (
								<>
									<Spinner size={14} />
									Removing...
								</>
							) : (
								"Remove Project"
							)}
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</aside>
	);
}

const TERMINAL_AGENT_HINTS: readonly { label: string; hint: string }[] = [
	{ label: "Create tasks", hint: "Ask your agent to add tasks, link them, and start working" },
	{ label: "Break down work", hint: "Ask to decompose a complex feature into linked subtasks" },
	{ label: "Import issues", hint: "Pull issues into task cards via GitHub CLI or Linear MCP" },
];

function TerminalAgentHints(): React.ReactElement {
	const [isDismissed, setIsDismissed] = useState(
		() => readLocalStorageItem(LocalStorageKey.AgentTipsDismissed) === "true",
	);

	const dismiss = useCallback(() => {
		setIsDismissed(true);
		writeLocalStorageItem(LocalStorageKey.AgentTipsDismissed, "true");
	}, []);

	const restore = useCallback(() => {
		setIsDismissed(false);
		removeLocalStorageItem(LocalStorageKey.AgentTipsDismissed);
	}, []);

	if (isDismissed) {
		return (
			<div className="shrink-0 px-3 pt-1">
				<button
					type="button"
					onClick={restore}
					className="flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-[11px] text-text-tertiary hover:text-text-secondary"
				>
					<Lightbulb size={11} />
					Show tips
				</button>
			</div>
		);
	}
	return (
		<div className="shrink-0 mx-2 mt-1 mb-1 rounded-md border border-border bg-surface-2/60 px-3 py-2">
			<div className="flex items-center justify-between mb-1.5">
				<span className="text-[11px] font-medium text-status-gold flex items-center gap-1">
					<Lightbulb size={11} />
					Tips
				</span>
				<button
					type="button"
					onClick={dismiss}
					aria-label="Dismiss tips"
					className="cursor-pointer border-none bg-transparent p-0 text-text-tertiary hover:text-text-secondary"
				>
					<X size={12} />
				</button>
			</div>
			<ul className="m-0 list-none space-y-1 pl-0">
				{TERMINAL_AGENT_HINTS.map((item) => (
					<li key={item.label} className="flex items-start gap-1.5 text-[11px] text-text-primary">
						<span className="mt-[5px] block h-1 w-1 shrink-0 rounded-full bg-text-tertiary" />
						<span>
							<span className="font-medium">{item.label}.</span> {item.hint}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function ProjectSupportFooter({
	shouldShowFeaturebaseFeedback,
	featurebaseFeedbackState,
}: {
	shouldShowFeaturebaseFeedback: boolean;
	featurebaseFeedbackState?: FeaturebaseFeedbackState;
}): React.ReactElement {
	const isOpening = featurebaseFeedbackState?.authState === "loading";

	const handleAction = () => {
		if (shouldShowFeaturebaseFeedback) {
			void featurebaseFeedbackState?.openFeedbackWidget();
		} else {
			window.open(GITHUB_ISSUES_URL, "_blank");
		}
	};

	const actionLabel = shouldShowFeaturebaseFeedback ? (isOpening ? "Opening..." : "Send feedback") : "Report issue";

	return (
		<div style={{ padding: "4px 12px 12px" }}>
			<div className="flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2.5">
				<Info size={14} className="mt-px shrink-0 text-text-tertiary" />
				<div className="flex flex-col gap-1.5">
					<p className="m-0 text-xs text-text-secondary">
						Kanban is in beta. Help us improve by sharing your experience.
					</p>
					<button
						type="button"
						className="m-0 flex cursor-pointer items-center gap-1 self-start border-none bg-transparent p-0 text-xs font-semibold text-text-secondary hover:text-text-primary active:text-text-tertiary disabled:cursor-default disabled:opacity-50"
						disabled={shouldShowFeaturebaseFeedback && isOpening}
						onClick={handleAction}
					>
						{actionLabel} {!isOpening && <ExternalLink size={11} />}
					</button>
				</div>
			</div>
		</div>
	);
}

const MOD = isMacPlatform ? "⌘" : modifierKeyLabel;
const ALT = isMacPlatform ? "⌥" : "Alt";

const ESSENTIAL_SHORTCUTS = [
	{ keys: ["C"], label: "New task" },
	{ keys: [MOD, "B"], label: "Start backlog tasks" },
	{ keys: [MOD, "Shift", "S"], label: "Settings" },
	{ keys: ["Click", MOD], label: "Hold to link tasks" },
	{ keys: [MOD, "G"], label: "Toggle git view" },
	{ keys: [MOD, "J"], label: "Toggle terminal" },
];

const MORE_SHORTCUTS = [
	{ keys: [MOD, "Shift", "A"], label: "Toggle plan / act" },
	{ keys: [ALT, "Shift", "Enter"], label: "Start and open task" },
	{ keys: [MOD, "M"], label: "Expand terminal" },
	{ keys: ["Esc"], label: "Close / back" },
];

function ShortcutHint({ keys, label }: { keys: string[]; label: string }): React.ReactElement {
	return (
		<div className="flex justify-between items-center py-px">
			<span className="text-text-tertiary text-xs">{label}</span>
			<span className="inline-flex items-center gap-0.5">
				{keys.map((key, i) => (
					<Kbd key={`${key}-${i}`}>{key}</Kbd>
				))}
			</span>
		</div>
	);
}

function ShortcutsCard(): React.ReactElement {
	const [expanded, setExpanded] = useState(false);

	return (
		<div style={{ padding: "8px 12px" }}>
			<div style={{ padding: "0 8px" }}>
				<div className="flex flex-col gap-0.5">
					{ESSENTIAL_SHORTCUTS.map((s) => (
						<ShortcutHint key={s.label} keys={s.keys} label={s.label} />
					))}
				</div>
				<Collapsible.Root open={expanded} onOpenChange={setExpanded}>
					<Collapsible.Content>
						<div className="flex flex-col gap-0.5">
							{MORE_SHORTCUTS.map((s) => (
								<ShortcutHint key={s.label} keys={s.keys} label={s.label} />
							))}
						</div>
					</Collapsible.Content>
					<Collapsible.Trigger asChild>
						<button
							type="button"
							className="flex items-center gap-1 mt-1.5 text-xs text-text-tertiary hover:text-text-secondary cursor-pointer bg-transparent border-none p-0"
						>
							{expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
							{expanded ? "Less" : "All shortcuts"}
						</button>
					</Collapsible.Trigger>
				</Collapsible.Root>
			</div>
		</div>
	);
}

function ProjectRowSkeleton(): React.ReactElement {
	return (
		<div
			className="flex items-center gap-1.5"
			style={{
				padding: "6px 8px",
			}}
		>
			<div className="flex-1 min-w-0">
				<div
					className="kb-skeleton"
					style={{
						height: 14,
						width: "58%",
						borderRadius: 3,
						marginBottom: 6,
					}}
				/>
				<div
					className="kb-skeleton font-mono"
					style={{
						height: 10,
						width: "86%",
						borderRadius: 3,
						marginBottom: 6,
					}}
				/>
				<div className="flex gap-1">
					<div className="kb-skeleton" style={{ height: 18, width: 30, borderRadius: 999 }} />
					<div className="kb-skeleton" style={{ height: 18, width: 30, borderRadius: 999 }} />
					<div className="kb-skeleton" style={{ height: 18, width: 30, borderRadius: 999 }} />
				</div>
			</div>
		</div>
	);
}

function ProjectRow({
	project,
	isCurrent,
	removingProjectId,
	onSelect,
	onRemove,
}: {
	project: RuntimeProjectSummary;
	isCurrent: boolean;
	removingProjectId: string | null;
	onSelect: (id: string) => void;
	onRemove: (id: string) => void;
}): React.ReactElement {
	const displayPath = formatPathForDisplay(project.path);
	const isRemovingProject = removingProjectId === project.id;
	const hasAnyProjectRemoval = removingProjectId !== null;
	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const taskCountBadges: TaskCountBadge[] = [
		{
			id: "backlog",
			title: "Backlog",
			shortLabel: "B",
			toneClassName: "bg-text-primary/15 text-text-primary",
			count: project.taskCounts.backlog,
		},
		{
			id: "in_progress",
			title: "In Progress",
			shortLabel: "IP",
			toneClassName: "bg-accent/20 text-accent",
			count: project.taskCounts.in_progress,
		},
		{
			id: "review",
			title: "Review",
			shortLabel: "R",
			toneClassName: "bg-accent-2/20 text-accent-2",
			count: project.taskCounts.review,
		},
		{
			id: "trash",
			title: "Done",
			shortLabel: "D",
			toneClassName: "bg-status-red/20 text-status-red",
			count: project.taskCounts.trash,
		},
	].filter((item) => item.count > 0);

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={() => onSelect(project.id)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onSelect(project.id);
				}
			}}
			className={cn("kb-project-row cursor-pointer rounded-md", isCurrent && "kb-project-row-selected")}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 6,
				padding: "6px 8px",
			}}
		>
			<div className="flex-1 min-w-0">
				<div
					className={cn(
						"font-medium whitespace-nowrap overflow-hidden text-ellipsis text-sm",
						isCurrent ? "text-accent-fg" : "text-text-primary",
					)}
				>
					{project.name}
				</div>
				<div
					className={cn(
						"font-mono text-[10px] whitespace-nowrap overflow-hidden text-ellipsis",
						isCurrent ? "text-accent-fg/60" : "text-text-secondary",
					)}
				>
					{displayPath}
				</div>
				{taskCountBadges.length > 0 ? (
					<div className="flex gap-1 mt-1">
						{taskCountBadges.map((badge) => (
							<span
								key={badge.id}
								className={cn(
									"inline-flex items-center gap-1 rounded-full text-[10px] px-1.5 py-px font-medium",
									isCurrent ? "bg-accent-fg/20 text-accent-fg" : badge.toneClassName,
								)}
								title={badge.title}
							>
								<span>{badge.shortLabel}</span>
								<span style={{ opacity: 0.4 }}>|</span>
								<span>{badge.count}</span>
							</span>
						))}
					</div>
				) : null}
			</div>
			<div className="kb-project-row-actions flex items-center" style={isMenuOpen ? { opacity: 1 } : undefined}>
				<DropdownMenu.Root open={isMenuOpen} onOpenChange={setIsMenuOpen}>
					<DropdownMenu.Trigger asChild>
						<Button
							variant="ghost"
							size="sm"
							icon={isRemovingProject ? <Spinner size={12} /> : <Ellipsis size={14} />}
							disabled={hasAnyProjectRemoval && !isRemovingProject}
							className={
								isCurrent
									? "text-accent-fg hover:bg-accent-fg/20 hover:text-accent-fg active:bg-accent-fg/30"
									: undefined
							}
							onClick={(e) => {
								e.stopPropagation();
							}}
							aria-label="Project actions"
						/>
					</DropdownMenu.Trigger>
					<DropdownMenu.Portal>
						<DropdownMenu.Content
							side="bottom"
							align="end"
							sideOffset={4}
							className="z-50 min-w-[140px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
							onCloseAutoFocus={(event) => event.preventDefault()}
						>
							<DropdownMenu.Item
								className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] text-status-red cursor-pointer outline-none data-[highlighted]:bg-surface-3"
								onSelect={() => onRemove(project.id)}
							>
								Delete
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Portal>
				</DropdownMenu.Root>
			</div>
		</div>
	);
}
