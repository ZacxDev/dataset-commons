// JSX typings for the @civitai/components custom elements this app renders
// directly (the upstream sidebar navigation). React 19 sets matching element
// properties for props that exist on the element class (label/href/current).
import type React from 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'civitai-nav-list': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        label?: string;
        current?: string;
      };
      'civitai-nav-item': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        label?: string;
        href?: string;
        current?: boolean;
        disabled?: boolean;
      };
      'civitai-avatar': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        name?: string;
        src?: string;
        size?: 'sm' | 'md' | 'lg' | 'xl';
      };
    }
  }
}

export {};
