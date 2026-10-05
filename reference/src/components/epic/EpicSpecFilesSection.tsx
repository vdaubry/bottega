/**
 * EpicSpecFilesSection — the functional specification the user uploaded, as
 * it currently is: the specification review stage amends it in place when the
 * user confirms a deviation, and the shared browser's mtime-keyed cache
 * reloads a rewritten file.
 *
 * Shown raw rather than rendered: the accepted formats are .md/.txt/.html, and
 * this is the *input* to the pipeline — what matters when checking an agent's
 * output is what the file actually says, not a prettified version of it. The
 * agents read these same bytes.
 */

import EpicFileBrowser from './EpicFileBrowser';
import { api } from '../../utils/api';
import type { EpicFileInfo } from '@shared/api/epics';

export interface EpicSpecFilesSectionProps {
  epicId: number;
  specFiles: EpicFileInfo[];
}

function EpicSpecFilesSection({ epicId, specFiles }: EpicSpecFilesSectionProps) {
  const loadFile = async (filename: string): Promise<string> => {
    const response = await api.epics.getSpecFile(epicId, filename);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).content;
  };

  return (
    <EpicFileBrowser
      files={specFiles}
      loadFile={loadFile}
      emptyNote="No functional specification was uploaded for this epic."
      render={(content) => (
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words text-sm">
          {content}
        </pre>
      )}
    />
  );
}

export default EpicSpecFilesSection;
