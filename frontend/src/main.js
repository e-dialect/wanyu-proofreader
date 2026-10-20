import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { refreshStoredAuth } from '@/services/authService'
import { documentTitleFor } from '@/lib/pageTitle'
import { focusMainLandmark } from '@/lib/mainLandmark'
import './style.css'

router.afterEach(async (to) => {
  document.title = documentTitleFor(to.name)
  await nextTick()
  focusMainLandmark()
})

async function bootstrap() {
  await refreshStoredAuth()
  const app = createApp(App)
  app.use(createPinia())
  app.use(router)
  app.mount('#app')
  await nextTick()
  focusMainLandmark()
}

bootstrap()
