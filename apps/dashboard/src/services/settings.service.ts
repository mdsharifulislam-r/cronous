import { projectService } from './project.service';
import { organizationService } from './organization.service';

/** Settings screens compose the organization and project services; nothing else is configurable server-side. */
export const settingsService = { organization: organizationService, project: projectService };
