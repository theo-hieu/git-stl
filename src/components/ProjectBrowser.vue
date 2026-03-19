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
            :disabled="isLoadingProject || isDeletingProject"
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
            :disabled="isFetchingProjects || isLoadingProject || isDeletingProject"
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
            <div class="project-preview">
              <img
                v-if="project.thumbnailSrc"
                :src="project.thumbnailSrc"
                :alt="`${project.name} thumbnail`"
                class="project-thumbnail"
              />
              <div v-else class="project-thumbnail-fallback" aria-hidden="true">
                {{ project.name.slice(0, 2).toUpperCase() }}
              </div>
            </div>

            <div class="project-copy">
              <strong class="project-name">{{ project.name }}</strong>
              <span class="project-date">
                Updated {{ formatModifiedDate(project.modifiedAt) }}
              </span>
            </div>

            <div class="project-actions">
              <button
                type="button"
                class="delete-btn"
                :disabled="isLoadingProject || isDeletingProject"
                @click="requestProjectDeletion(project)"
              >
                {{
                  deletingProjectName === project.name && isDeletingProject
                    ? "Deleting..."
                    : "Delete"
                }}
              </button>

              <button
                type="button"
                class="open-btn"
                :disabled="isLoadingProject || isDeletingProject"
                @click="loadProject(project.name)"
              >
                {{
                  loadingProjectName === project.name
                    ? "Opening..."
                    : "Open"
                }}
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>

    <div
      v-if="pendingDeletionProject"
      class="confirm-backdrop"
      @click.self="cancelProjectDeletion"
    >
      <section class="confirm-panel" aria-label="Delete project confirmation">
        <p class="eyebrow warning-eyebrow">Delete Project</p>
        <h2>Are you sure?</h2>
        <p class="confirm-copy">
          This will permanently delete
          <strong>{{ pendingDeletionProject.name }}</strong>,
          including its version history, manifest, parts, and thumbnail.
        </p>

        <div class="confirm-actions">
          <button
            type="button"
            class="close-btn"
            :disabled="isDeletingProject"
            @click="cancelProjectDeletion"
          >
            Cancel
          </button>

          <button
            type="button"
            class="delete-btn confirm-delete-btn"
            :disabled="isDeletingProject"
            @click="confirmProjectDeletion"
          >
            {{ isDeletingProject ? "Deleting..." : "Yes, Delete Project" }}
          </button>
        </div>
      </section>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { useProjectBrowser } from "../composables/useProjectBrowser";

const {
  browserError,
  cancelProjectDeletion,
  closeBrowser,
  confirmProjectDeletion,
  deletingProjectName,
  fetchProjects,
  filteredProjects,
  isDeletingProject,
  isFetchingProjects,
  isLoadingProject,
  isProjectBrowserOpen,
  loadProject,
  loadingProjectName,
  pendingDeletionProject,
  projects,
  requestProjectDeletion,
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

.project-preview {
  width: 88px;
  height: 64px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(71, 85, 105, 0.8);
  background:
    radial-gradient(circle at top right, rgba(59, 130, 246, 0.16), transparent 45%),
    linear-gradient(180deg, rgba(30, 41, 59, 0.95), rgba(15, 23, 42, 0.95));
  flex-shrink: 0;
}

.project-thumbnail {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.project-thumbnail-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #bfdbfe;
  font-size: 1rem;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.project-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.project-name {
  color: #f8fafc;
  font-size: 0.95rem;
}

.project-date {
  color: #94a3b8;
  font-size: 0.8rem;
}

.project-actions {
  display: flex;
  align-items: center;
  gap: 10px;
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
.open-btn,
.delete-btn {
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

.delete-btn {
  padding: 10px 16px;
  background: rgba(127, 29, 29, 0.95);
  color: #fee2e2;
  min-width: 96px;
}

.close-btn:hover,
.refresh-btn:hover,
.open-btn:hover,
.delete-btn:hover {
  transform: translateY(-1px);
}

.close-btn:disabled,
.refresh-btn:disabled,
.open-btn:disabled,
.delete-btn:disabled {
  cursor: wait;
  opacity: 0.65;
  transform: none;
}

.confirm-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(2, 6, 23, 0.76);
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 24px;
  z-index: 60;
}

.confirm-panel {
  width: min(460px, 100%);
  background:
    radial-gradient(circle at top right, rgba(248, 113, 113, 0.14), transparent 42%),
    linear-gradient(180deg, #111827 0%, #0f172a 100%);
  border: 1px solid rgba(248, 113, 113, 0.22);
  border-radius: 18px;
  box-shadow: 0 28px 64px rgba(15, 23, 42, 0.5);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  color: #e2e8f0;
}

.warning-eyebrow {
  color: #fca5a5;
}

.confirm-panel h2 {
  margin: -6px 0 0;
  font-size: 1.45rem;
}

.confirm-copy {
  margin: 0;
  color: #cbd5e1;
  line-height: 1.5;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.confirm-delete-btn {
  min-width: 170px;
}

@media (max-width: 720px) {
  .project-browser-backdrop {
    padding: 12px;
  }

  .project-browser-panel {
    padding: 18px;
  }

  .project-browser-toolbar,
  .project-item,
  .confirm-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .project-preview {
    width: 100%;
    height: 140px;
  }

  .open-btn,
  .delete-btn,
  .refresh-btn,
  .close-btn {
    width: 100%;
  }

  .project-actions {
    width: 100%;
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
