import './style.css'
import HomeApp from './HomeApp.vue'

export default (ctx: any) => {
  if (ctx.$router?.cache) {
    ctx.$router.cache.home = '/'
  }

  ctx.slot({
    type: 'home',
    order: 3000,
    component: HomeApp,
  })
}
