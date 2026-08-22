import React from 'react';
import { Strings } from '@/data/Strings';

export interface CrashReportPromptProps {
    message: string;
    discordUrl?: string;
    strings: Strings;
}

// Combines what previously would have been two separate dialogs (a generic
// "submit a report?" ask, then -- only after that resolved -- the actual
// error dialog) into one: the real failure reason, why submitting a report
// is worth doing, and the Discord link, all in a single prompt with
// Submit/Skip buttons. See GameScreen.maybeSubmitErrorReport.
export const CrashReportPrompt: React.FC<CrashReportPromptProps> = ({ message, discordUrl, strings }) => {
    return (<div style={{ padding: '20px', color: 'white' }}>
      <div style={{ marginBottom: '15px', whiteSpace: 'pre-line' }}>
        {message}
      </div>
      <div style={{ marginBottom: '15px' }}>
        {strings.get('TS:SubmitCrashReportPersuasion') ||
            'Submitting a diagnostic report helps us find and fix issues like this one, ' +
            'and makes the game better for the whole community.'}
      </div>
      {discordUrl && (<div style={{ textAlign: 'center' }}>
          <a href={discordUrl} target="_blank" rel="noopener noreferrer" style={{
                color: '#00ff00',
                textDecoration: 'underline',
                fontSize: '16px'
            }}>
            {discordUrl}
          </a>
        </div>)}
    </div>);
};
