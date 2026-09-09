import React from 'react';
interface VersionStringProps {
    value: string;
    dimmed?: boolean;
}
export const VersionString: React.FC<VersionStringProps> = ({ value, dimmed = false }) => {
    const className = dimmed ? "menu-version-string menu-version-string--dimmed" : "menu-version-string";
    return (<div className={className}>
      v{value}
    </div>);
};
