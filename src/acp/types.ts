/** ACP v1 wire types used by the Supercharge Studio. */
export type JsonRpcId = number | string;

export type JsonRpcError = { code: number; message: string; data?: unknown };

export type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: JsonRpcId | null;
  method?: string;
  params?: any;
  result?: any;
  error?: JsonRpcError;
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string }
  | { type: "resource"; resource: { uri: string; text?: string; mimeType?: string } }
  | { type: string; [k: string]: unknown };

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string }
  | { type: string; [k: string]: unknown };

export type ToolCallLocation = { path: string; line?: number };

export type ToolCall = {
  toolCallId: string;
  title: string;
  kind?: string;
  status: ToolCallStatus;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
};

export type PlanEntry = { content: string; priority?: string; status?: string };

/** Agent → client request when a plan is ready to leave plan mode. */
export type PlanApprovalRequest = {
  sessionId: string;
  toolCallId?: string;
  planContent?: string | null;
};

export type PlanApprovalResult = {
  outcome: "approved" | "cancelled" | "abandoned";
  feedback?: string;
};

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | ({ sessionUpdate: "tool_call" } & Partial<ToolCall> & { toolCallId: string })
  | ({ sessionUpdate: "tool_call_update" } & Partial<ToolCall> & { toolCallId: string })
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: { name: string; description?: string }[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: string; [k: string]: unknown };

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
};

export type PermissionRequest = {
  sessionId: string;
  toolCall: Partial<ToolCall> & { toolCallId: string };
  options: PermissionOption[];
};

export type PermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | string;

export type InitializeResult = {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: Record<string, boolean>;
    mcpCapabilities?: Record<string, boolean>;
    _meta?: Record<string, unknown>;
    [k: string]: unknown;
  };
  authMethods?: { id: string; name: string; description?: string }[];
  agentInfo?: { name?: string; title?: string; version?: string };
  _meta?: Record<string, unknown>;
};

export type ConfigOption = {
  id: string;
  name?: string;
  currentValue?: string;
  options?: { value: string; name?: string }[];
  [k: string]: unknown;
};

export type SessionModes = {
  currentModeId: string;
  availableModes: { id: string; name: string; description?: string }[];
};

export type NewSessionResult = {
  sessionId: string;
  configOptions?: ConfigOption[];
  modes?: SessionModes;
  models?: unknown;
};
