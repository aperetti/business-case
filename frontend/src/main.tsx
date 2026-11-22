import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './index.css';
import App from './App';

const theme = createTheme({
  primaryColor: 'slateIndigo',
  primaryShade: { light: 7, dark: 5 },
  colors: {
    slateIndigo: [
      '#f3f5fa',
      '#e5e9f3',
      '#cbd3e6',
      '#aebad8',
      '#8d9ec8',
      '#6f82b3',
      '#55689b',
      '#475587',
      '#3b4770',
      '#2f395b',
    ],
  },
  fontFamily:
    'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  defaultRadius: 'md',
  components: {
    Paper: {
      styles: {
        root: {
          borderColor: 'var(--border-subtle)',
        },
      },
    },
    Modal: {
      styles: {
        content: {
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
        },
        header: {
          backgroundColor: 'var(--bg-surface)',
        },
      },
    },
    Drawer: {
      styles: {
        content: {
          backgroundColor: 'var(--bg-surface)',
        },
        header: {
          backgroundColor: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-subtle)',
        },
      },
    },
    Button: {
      styles: {
        root: {
          fontWeight: 500,
        },
      },
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <Notifications position="bottom-right" limit={2} autoClose={3000} />
      <App />
    </MantineProvider>
  </StrictMode>
);
