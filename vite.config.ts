import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // แยกก้อนหนักออกไป โหลดเฉพาะตอนใช้จริง หน้าแรกจึงขึ้นเร็ว
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('exceljs')) return 'exceljs';
          if (id.includes('xlsx')) return 'xlsx';
          if (id.includes('@supabase')) return 'supabase';
          if (id.includes('react')) return 'react';
        },
      },
    },
  },
});
