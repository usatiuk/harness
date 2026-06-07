CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`turn_id` text,
	`parent_activity_id` text,
	`owner_plugin_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`status` text NOT NULL,
	`cancellable` integer NOT NULL,
	`activity_state_json` text,
	`result_json` text,
	`on_completion_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activities_conversation_idx` ON `activities` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `activities_turn_idx` ON `activities` (`turn_id`);--> statement-breakpoint
CREATE INDEX `activities_parent_idx` ON `activities` (`parent_activity_id`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`turn_id` text,
	`source_type` text,
	`source_id` text,
	`kind` text NOT NULL,
	`uri` text,
	`metadata_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `artifacts_conversation_idx` ON `artifacts` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `artifacts_turn_idx` ON `artifacts` (`turn_id`);--> statement-breakpoint
CREATE INDEX `artifacts_source_idx` ON `artifacts` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
	`turn_id` text,
	`source_type` text,
	`source_id` text,
	`message_id` text,
	`uri` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text,
	`origin_json` text NOT NULL,
	`metadata_json` text NOT NULL,
	`derived_from_asset_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `assets_conversation_idx` ON `assets` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `assets_turn_idx` ON `assets` (`turn_id`);--> statement-breakpoint
CREATE INDEX `assets_source_idx` ON `assets` (`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `assets_message_idx` ON `assets` (`message_id`);--> statement-breakpoint
CREATE TABLE `context_block_sources` (
	`block_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text,
	`metadata_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_block_sources_block_idx` ON `context_block_sources` (`block_id`);--> statement-breakpoint
CREATE TABLE `context_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`turn_id` text,
	`source_type` text,
	`source_id` text,
	`kind` text NOT NULL,
	`content_json` text NOT NULL,
	`data_json` text,
	`metadata_json` text NOT NULL,
	`coverage_cursor` text,
	`policy_id` text,
	`source_context_build_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_blocks_conversation_idx` ON `context_blocks` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `context_blocks_turn_idx` ON `context_blocks` (`turn_id`);--> statement-breakpoint
CREATE INDEX `context_blocks_kind_idx` ON `context_blocks` (`kind`);--> statement-breakpoint
CREATE INDEX `context_blocks_source_idx` ON `context_blocks` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `context_build_items` (
	`context_build_id` text NOT NULL,
	`block_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`role` text,
	`token_estimate` integer,
	`metadata_json` text NOT NULL,
	PRIMARY KEY(`context_build_id`, `sequence`)
);
--> statement-breakpoint
CREATE INDEX `context_build_items_block_idx` ON `context_build_items` (`block_id`);--> statement-breakpoint
CREATE TABLE `context_builds` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`turn_id` text,
	`model_config_json` text NOT NULL,
	`policy_id` text NOT NULL,
	`diagnostics_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_builds_conversation_idx` ON `context_builds` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `context_builds_turn_idx` ON `context_builds` (`turn_id`);--> statement-breakpoint
CREATE TABLE `context_model_metadata` (
	`id` text PRIMARY KEY NOT NULL,
	`block_id` text NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`metadata_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_model_metadata_block_idx` ON `context_model_metadata` (`block_id`);--> statement-breakpoint
CREATE INDEX `context_model_metadata_provider_idx` ON `context_model_metadata` (`provider`,`model_id`);--> statement-breakpoint
CREATE TABLE `conversation_inputs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`turn_id` text,
	`source` text NOT NULL,
	`source_type` text,
	`source_id` text,
	`delivery` text NOT NULL,
	`target` text NOT NULL,
	`role` text NOT NULL,
	`content_json` text NOT NULL,
	`status` text NOT NULL,
	`consumed_message_id` text,
	`created_at` text NOT NULL,
	`consumed_at` text
);
--> statement-breakpoint
CREATE INDEX `conversation_inputs_conversation_status_idx` ON `conversation_inputs` (`conversation_id`,`status`);--> statement-breakpoint
CREATE INDEX `conversation_inputs_turn_status_idx` ON `conversation_inputs` (`turn_id`,`status`);--> statement-breakpoint
CREATE INDEX `conversation_inputs_source_idx` ON `conversation_inputs` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_conversation_id` text,
	`profile_id` text,
	`effective_profile_json` text NOT NULL,
	`execution_context_id` text,
	`provider_resume_state_json` text,
	`title` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_parent_idx` ON `conversations` (`parent_conversation_id`);--> statement-breakpoint
CREATE INDEX `conversations_profile_idx` ON `conversations` (`profile_id`);--> statement-breakpoint
CREATE INDEX `conversations_execution_context_idx` ON `conversations` (`execution_context_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`turn_id` text,
	`source_type` text,
	`source_id` text,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_id_unique` ON `events` (`id`);--> statement-breakpoint
CREATE INDEX `events_conversation_sequence_idx` ON `events` (`conversation_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `events_turn_sequence_idx` ON `events` (`turn_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `events_source_idx` ON `events` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `execution_contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
	`workspace_id` text,
	`provider_kind` text NOT NULL,
	`cwd` text,
	`env_json` text NOT NULL,
	`provider_config_json` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `execution_contexts_conversation_idx` ON `execution_contexts` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `execution_contexts_workspace_idx` ON `execution_contexts` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `interaction_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`tool_execution_id` text,
	`activity_id` text,
	`origin` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`prompt_json` text NOT NULL,
	`requested_schema_json` text,
	`render_json` text,
	`response_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `interaction_requests_conversation_idx` ON `interaction_requests` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `interaction_requests_turn_idx` ON `interaction_requests` (`turn_id`);--> statement-breakpoint
CREATE INDEX `interaction_requests_status_idx` ON `interaction_requests` (`status`);--> statement-breakpoint
CREATE INDEX `interaction_requests_tool_execution_idx` ON `interaction_requests` (`tool_execution_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`turn_id` text,
	`role` text NOT NULL,
	`content_json` text NOT NULL,
	`source_type` text,
	`source_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_sequence_unique` ON `messages` (`conversation_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `messages_conversation_sequence_idx` ON `messages` (`conversation_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `messages_turn_idx` ON `messages` (`turn_id`);--> statement-breakpoint
CREATE INDEX `messages_source_idx` ON `messages` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `plugin_kv` (
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`namespace`, `key`)
);
--> statement-breakpoint
CREATE TABLE `plugin_migrations` (
	`plugin_id` text NOT NULL,
	`migration_id` text NOT NULL,
	`applied_at` text NOT NULL,
	PRIMARY KEY(`plugin_id`, `migration_id`)
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_name_unique` ON `profiles` (`name`);--> statement-breakpoint
CREATE TABLE `state_namespaces` (
	`conversation_id` text NOT NULL,
	`namespace` text NOT NULL,
	`value_json` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`conversation_id`, `namespace`)
);
--> statement-breakpoint
CREATE TABLE `tool_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`request_message_id` text,
	`context_build_id` text,
	`tool_call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`input_json` text NOT NULL,
	`status` text NOT NULL,
	`pending_interaction_ids_json` text NOT NULL,
	`resume_state_json` text,
	`result_json` text,
	`created_activity_ids_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tool_executions_conversation_idx` ON `tool_executions` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `tool_executions_turn_idx` ON `tool_executions` (`turn_id`);--> statement-breakpoint
CREATE INDEX `tool_executions_tool_call_idx` ON `tool_executions` (`conversation_id`,`tool_call_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tool_executions_turn_tool_call_unique` ON `tool_executions` (`turn_id`,`tool_call_id`);--> statement-breakpoint
CREATE TABLE `turn_states` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`phase` text NOT NULL,
	`active_tool_execution_id` text,
	`active_activity_id` text,
	`context_build_id` text,
	`pending_tool_calls_json` text NOT NULL,
	`completed_tool_call_ids_json` text NOT NULL,
	`pending_interaction_ids_json` text NOT NULL,
	`pending_steering_message_ids_json` text NOT NULL,
	`provider_resume_state_json` text,
	`loop_state_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_states_turn_unique` ON `turn_states` (`turn_id`);--> statement-breakpoint
CREATE INDEX `turn_states_conversation_idx` ON `turn_states` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`parent_turn_id` text,
	`status` text NOT NULL,
	`input_message_ids_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turns_conversation_idx` ON `turns` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `turns_status_idx` ON `turns` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `turns_one_active_per_conversation_unique` ON `turns` (`conversation_id`) WHERE status in ('running', 'waiting');--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`root_path` text,
	`metadata_json` text NOT NULL,
	`created_at` text NOT NULL
);
