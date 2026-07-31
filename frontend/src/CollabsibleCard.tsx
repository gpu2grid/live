import React, { useState } from 'react';

interface CollapsibleCardProps {
  title: string;
  subtitle?: string;
  summary?: React.ReactNode; 
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export const CollapsibleCard: React.FC<CollapsibleCardProps> = ({
  title,
  subtitle,
  summary,
  defaultOpen = true,
  children,
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div
      style={{
        marginBottom: 16,
        borderRadius: 10,
        border: '1px solid #cbd5e1',
        backgroundColor: '#ffffff',
        overflow: 'hidden',
        boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
      }}
    >
      {/* Header Bar */}
      <div
        onClick={() => setIsOpen((prev) => !prev)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justify: 'space-between',
          padding: '12px 16px',
          backgroundColor: '#f8fafc',
          cursor: 'pointer',
          userSelect: 'none',
          borderBottom: isOpen ? '1px solid #e2e8f0' : 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Chevron */}
          <span
            style={{
              fontSize: 11,
              color: '#64748b',
              display: 'inline-block',
              transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
              transition: 'transform 0.2s ease',
            }}
          >
            ▼
          </span>

          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>
              {title}
            </div>
            {subtitle && (
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>
                {subtitle}
              </div>
            )}
          </div>
        </div>

        {/* Show optional summary badges when collapsed */}
        {!isOpen && summary && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {summary}
          </div>
        )}
      </div>

      {/* Content Area */}
      {isOpen && <div style={{ padding: 16 }}>{children}</div>}
    </div>
  );
};