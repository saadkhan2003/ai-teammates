FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY global.json ./
COPY src/Compute.Domain/ src/Compute.Domain/
COPY src/Compute.Docker/ src/Compute.Docker/
COPY apps/api/ apps/api/
COPY services/computer/src/workspace.py services/computer/src/workspace.py
COPY services/agent/workspace_shell.py services/agent/workspace_shell.py
RUN dotnet publish apps/api/Teammates.Api.csproj -c Release -o /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0
RUN apt-get update && apt-get install -y --no-install-recommends curl tzdata && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://0.0.0.0:8080 \
    DOTNET_gcServer=0 \
    DOTNET_GCHeapHardLimit=0x10000000
EXPOSE 8080
COPY db/001_init.sql /migrations/001_init.sql
COPY db/002_reactions.sql /migrations/002_reactions.sql
COPY db/003_v02.sql /migrations/003_v02.sql
COPY db/004_resources.sql /migrations/004_resources.sql
COPY db/005_plugins.sql /migrations/005_plugins.sql
COPY db/006_security.sql /migrations/006_security.sql
COPY db/007_credential_grants.sql /migrations/007_credential_grants.sql
COPY db/008_plugin_catalog.sql /migrations/008_plugin_catalog.sql
COPY db/009_v03.sql /migrations/009_v03.sql
COPY db/010_provider.sql /migrations/010_provider.sql
COPY db/011_devices.sql /migrations/011_devices.sql
COPY db/012_reliability.sql /migrations/012_reliability.sql
COPY db/013_feedback.sql /migrations/013_feedback.sql
COPY db/014_avatar.sql /migrations/014_avatar.sql
COPY db/015_bot_messaging.sql /migrations/015_bot_messaging.sql
COPY db/016_chat_actions.sql /migrations/016_chat_actions.sql
COPY db/017_primary.sql /migrations/017_primary.sql
COPY db/018_bio.sql /migrations/018_bio.sql
COPY db/019_coding_work.sql /migrations/019_coding_work.sql
COPY db/020_coding_items.sql /migrations/020_coding_items.sql
COPY db/021_routine_timezone.sql /migrations/021_routine_timezone.sql
COPY db/022_routines_v2.sql /migrations/022_routines_v2.sql
COPY db/023_routine_test.sql /migrations/023_routine_test.sql
COPY db/024_library.sql /migrations/024_library.sql
COPY db/025_library_actions.sql /migrations/025_library_actions.sql
COPY db/026_library_shares.sql /migrations/026_library_shares.sql
COPY db/027_memory_notes.sql /migrations/027_memory_notes.sql
COPY db/028_long_run_resume.sql /migrations/028_long_run_resume.sql
COPY db/029_resume_timing.sql /migrations/029_resume_timing.sql
COPY db/030_tool_dedupe.sql /migrations/030_tool_dedupe.sql
COPY db/031_pause_on_budget.sql /migrations/031_pause_on_budget.sql
COPY db/032_transcript_archive.sql /migrations/032_transcript_archive.sql
COPY db/033_watchdog.sql /migrations/033_watchdog.sql
COPY db/034_approval_rules.sql /migrations/034_approval_rules.sql
COPY db/035_approval_rules_upgrade.sql /migrations/035_approval_rules_upgrade.sql
COPY db/036_rule_scope.sql /migrations/036_rule_scope.sql
COPY db/037_device_commands.sql /migrations/037_device_commands.sql
COPY db/038_computer_windows.sql /migrations/038_computer_windows.sql
COPY db/039_desktop_lease.sql /migrations/039_desktop_lease.sql
COPY db/040_tickets_state.sql /migrations/040_tickets_state.sql
COPY db/041_skill_library.sql /migrations/041_skill_library.sql
COPY db/042_video_analyses.sql /migrations/042_video_analyses.sql
COPY services/agent/skills/builtin/ /skills/builtin/
ENTRYPOINT ["dotnet", "Teammates.Api.dll"]
COPY db/055_skills_v2.sql /migrations/055_skills_v2.sql
