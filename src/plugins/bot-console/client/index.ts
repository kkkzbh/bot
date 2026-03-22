import './style.css'
import HomeApp from './HomeApp.vue'

export default (ctx: any) => {
  ctx.slot({
    type: 'home',
    order: 3000,
    component: HomeApp,
  })
}
