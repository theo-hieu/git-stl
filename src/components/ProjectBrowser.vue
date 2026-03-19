<template>
  <teleport to="body">
    <div
      v-if="isProjectBrowserOpen"
      class="project-browser-backdrop"
      @click.self="closeBrowser"
    >
      <section class="project-browser-panel" aria-label="Project Browser">
        <header class="project-browser-header">
          <div>
            <p class="eyebrow">Local Projects</p>
            <h2>Open Project</h2>
          </div>

          <button
            type="button"
            class="close-btn"
            :disabled="isLoadingProject"
            @click="closeBrowser"
          >
            Close
          </button>
        </header>

        <div class="project-browser-toolbar">
          <label class="search-field">
            <span class="field-label">Search</span>
            <input
              v-model="searchQuery"
              type="search"
              class="search-input"
              placeholder="Find a project by name"
            />
          </label>

          <button
            type="button"
            class="refresh-btn"
            :disabled="isFetchingProjects || isLoadingProject"
            @click="fetchProjects"
          >
            {{ isFetchingProjects ? "Refreshing..." : "Refresh" }}
          </button>
        </div>

        <p v-if="browserError" class="status-message error-message">
          {{ browserError }}
        </p>
        <p v-else-if="isFetchingProjects" class="status-message">
          Scanning the local project directory...
        </p>
        <p v-else-if="projects.length === 0" class="status-message">
          No saved projects were found in app data yet.
        </p>
        <p
          v-else-if="filteredProjects.length === 0"
          class="status-message"
        >
          No projects match "{{ searchQuery }}".
        </p>

        <ul
          v-if="filteredProjects.length > 0"
          class="project-list"
        >
          <li
            v-for="project in filteredProjects"
            :key="project.name"
            class="project-item"
          >
            <div class="project-copy">
              <strong class="project-name">{{ project.name }}</strong>
              <span class="project-date">
                Updated {{ formatModifiedDate(project.modifiedAt) }}
              </span>
            </div>

            <button
              type="button"
              class="open-btn"
              :disabled="isLoadingProject"
              @click="loadProject(project.name)"
            >
              {{
                loadingProjectName === project.name
                  ? "Opening..."
                  : "Open"
              }}
            </button>
          </li>
        </ul>
      </section>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { useProjectBrowser } from "../composables/useProjectBrowser";

const {
  browserError,
  closeBrowser,
  fetchProjects,
  filteredProjects,
  isFetchingProjects,
  isLoadingProject,
  isProjectBrowserOpen,
  loadProject,
  loadingProjectName,
  projects,
  searchQuery,
} = useProjectBrowser();

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatModifiedDate(modifiedAt: number): string {
  if (!modifiedAt) {
    return "Unknown";
  }

  return dateFormatter.format(new Date(modifiedAt));
}
</script>

<style scoped>
.project-browser-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(2, 6, 23, 0.72);
  backdrop-filter: blur(10px);
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 24px;
  z-index: 50;
}

.project-browser-panel {
  width: min(760px, 100%);
  max-height: min(640px, 100%);
  background:
    radial-gradient(circle at top right, rgba(59, 130, 246, 0.16), transparent 40%),
    linear-gradient(180deg, #111827 0%, #0f172a 100%);
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 18px;
  box-shadow: 0 32px 80px rgba(15, 23, 42, 0.45);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  color: #e2e8f0;
}

.project-browser-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.project-browser-header h2 {
  margin: 4px 0 0;
  font-size: 1.4rem;
}

.eyebrow {
  margin: 0;
  color: #93c5fd;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.72rem;
  font-weight: 700;
}

.project-browser-toolbar {
  display: flex;
  gap: 12px;
  align-items: end;
}

.search-field {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 0.8rem;
  color: #cbd5e1;
  font-weight: 600;
}

.search-input {
  width: 100%;
  background: rgba(15, 23, 42, 0.85);
  border: 1px solid rgba(71, 85, 105, 0.9);
  border-radius: 10px;
  color: #f8fafc;
  padding: 11px 12px;
  font-size: 0.92rem;
}

.search-input:focus {
  outline: none;
  border-color: #60a5fa;
  box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.15);
}

.project-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}

.project-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.86);
  border: 1px solid rgba(71, 85, 105, 0.7);
}

.project-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.project-name {
  color: #f8fafc;
  font-size: 0.95rem;
}

.project-date {
  color: #94a3b8;
  font-size: 0.8rem;
}

.status-message {
  margin: 0;
  color: #94a3b8;
  font-size: 0.88rem;
}

.error-message {
  color: #fca5a5;
}

.close-btn,
.refresh-btn,
.open-btn {
  border: none;
  border-radius: 10px;
  font-weight: 700;
  cursor: pointer;
  transition:
    transform 0.15s ease,
    opacity 0.15s ease,
    background-color 0.15s ease;
}

.close-btn,
.refresh-btn {
  padding: 10px 14px;
  background: rgba(30, 41, 59, 0.95);
  color: #e2e8f0;
}

.open-btn {
  padding: 10px 16px;
  background: linear-gradient(135deg, #0ea5e9, #2563eb);
  color: white;
  min-width: 96px;
}

.close-btn:hover,
.refresh-btn:hover,
.open-btn:hover {
  transform: translateY(-1px);
}

.close-btn:disabled,
.refresh-btn:disabled,
.open-btn:disabled {
  cursor: wait;
  opacity: 0.65;
  transform: none;
}

@media (max-width: 720px) {
  .project-browser-backdrop {
    padding: 12px;
  }

  .project-browser-panel {
    padding: 18px;
  }

  .project-browser-toolbar,
  .project-item {
    flex-direction: column;
    align-items: stretch;
  }

  .open-btn,
  .refresh-btn,
  .close-btn {
    width: 100%;
  }
}
</style>
