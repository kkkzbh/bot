import './style.css'
import App from './App.vue'

export default (ctx: any) => {
  ctx.page({
    id: 'bot-console',
    path: '/bot-console',
    name: '机器人控制台',
    icon: 'activity:settings',
    order: 420,
    component: App,
  })
}
