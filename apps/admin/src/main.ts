import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { useAuthStore } from '@/stores/auth'
import '@/styles/index.css'

const app = createApp(App)
app.use(createPinia())

// http 的 refresh 回调依赖 pinia store，先初始化再挂路由
const auth = useAuthStore()
auth.bindHttp()

app.use(router)
app.mount('#app')
